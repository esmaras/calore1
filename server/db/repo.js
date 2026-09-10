const crypto = require("crypto");
const {
  ScanCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  TransactWriteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { doc } = require("./client");
const config = require("../config");
const { keys, itemTypes } = require("./keys");
const { getActor } = require("../auth/actorContext");

const TABLE = config.dynamodbTable;

// Never recorded in the audit log's before/after values, even though
// they're bcrypt hashes rather than plaintext — no reason to duplicate
// them into a second, more broadly-browsed store. Mirrors the same
// exclusion already applied to the admin user-list API response (see
// server/routes/admin.routes.js).
const AUDIT_REDACTED_FIELDS = new Set(["passwordHash"]);

function diffFields(before, after, fields) {
  const changes = [];
  for (const field of fields) {
    if (AUDIT_REDACTED_FIELDS.has(field)) continue;
    const beforeVal = before ? before[field] : undefined;
    const afterVal = after ? after[field] : undefined;
    if (JSON.stringify(beforeVal) !== JSON.stringify(afterVal)) {
      changes.push({ field, before: beforeVal ?? null, after: afterVal ?? null });
    }
  }
  return changes;
}

// Reconstructs the `{ field: newValue }` an UpdateCommand-shaped transact
// entry is SETting, by pairing up each #name alias with its :value alias
// of the same suffix (the convention every SET-only UpdateExpression in
// this codebase follows — see repo.js's own updateItem() above, and
// drivers.routes.js's car-color route). Only covers plain SET; nothing
// here uses REMOVE/list_append, so there's no case for it yet.
function attrsFromUpdateParams(params) {
  const attrs = {};
  const names = params.ExpressionAttributeNames || {};
  const values = params.ExpressionAttributeValues || {};
  for (const [nameAlias, field] of Object.entries(names)) {
    const valueAlias = `:${nameAlias.slice(1)}`;
    if (valueAlias in values) attrs[field] = values[valueAlias];
  }
  return attrs;
}

// Writes the audit entry directly via `doc.send`, not through putItem —
// going through putItem would recursively try to audit-log the audit log
// itself. Attributed to whoever's making the current request (see
// server/auth/actorContext.js); outside a request (migrations, scripts)
// that's null, logged as "system". A no-op if nothing actually changed —
// callers still fire on every write attempt, but a save that didn't
// change any field shouldn't clutter the log.
async function recordAudit({ action, targetItemType, targetKey, changes }) {
  if (!changes.length) return;
  const actor = getActor();
  const id = crypto.randomUUID();
  const entry = {
    ...keys.auditLogEntry(id),
    itemType: itemTypes.AUDIT_LOG,
    id,
    timestamp: new Date().toISOString(),
    actor: actor?.username || "system",
    actorRole: actor?.role || null,
    action, // "create" | "update" | "delete"
    targetItemType: targetItemType || null,
    targetKey,
    changes,
  };
  await doc.send(new PutCommand({ TableName: TABLE, Item: entry }));
}

// The whole app's data comfortably fits in memory (~150 items). Rather than
// design GSIs/queries for every access pattern, we keep one full-table Scan
// cached in-process and refresh it after every write. This is a deliberate
// simplification appropriate for a handful of concurrent users — see the
// plan doc for the reasoning. If this app ever needed to scale past a few
// hundred items, this is the first thing to revisit.
let cache = null; // Array<item> | null

async function scanAll() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await doc.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey }));
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  cache = items;
  return cache;
}

async function getAll() {
  if (cache === null) await scanAll();
  return cache;
}

function byItemType(items, itemType) {
  return items.filter((i) => i.itemType === itemType);
}

function byPKPrefix(items, prefix) {
  return items.filter((i) => typeof i.PK === "string" && i.PK.startsWith(prefix));
}

async function getItem(key) {
  const res = await doc.send(new GetCommand({ TableName: TABLE, Key: key }));
  return res.Item || null;
}

async function putItem(item) {
  const before = (await getAll()).find((i) => i.PK === item.PK && i.SK === item.SK) || null;
  await doc.send(new PutCommand({ TableName: TABLE, Item: item }));
  const fields = new Set([...(before ? Object.keys(before) : []), ...Object.keys(item)]);
  fields.delete("PK");
  fields.delete("SK");
  await recordAudit({
    action: before ? "update" : "create",
    targetItemType: item.itemType,
    targetKey: { PK: item.PK, SK: item.SK },
    changes: diffFields(before, item, [...fields]),
  });
  await scanAll();
  return item;
}

// Writes many items without re-scanning the table between each one (a
// single putItem() per row would mean one full Scan per row — fine for a
// single edit, wasteful for bulk writes like migration or the transitional
// whole-blob save). Refreshes the cache once at the end instead.
async function putItemsBulk(items) {
  const before = await getAll();
  const beforeByKey = new Map(before.map((i) => [`${i.PK}#${i.SK}`, i]));
  for (const item of items) {
    // eslint-disable-next-line no-await-in-loop
    await doc.send(new PutCommand({ TableName: TABLE, Item: item }));
  }
  for (const item of items) {
    const prior = beforeByKey.get(`${item.PK}#${item.SK}`) || null;
    const fields = new Set([...(prior ? Object.keys(prior) : []), ...Object.keys(item)]);
    fields.delete("PK");
    fields.delete("SK");
    // eslint-disable-next-line no-await-in-loop
    await recordAudit({
      action: prior ? "update" : "create",
      targetItemType: item.itemType,
      targetKey: { PK: item.PK, SK: item.SK },
      changes: diffFields(prior, item, [...fields]),
    });
  }
  await scanAll();
  return items;
}

// Partial attribute update. `attrs` is a flat object of top-level
// attributes to set (never PK/SK). Returns the updated item.
async function updateItem(key, attrs, { conditionExpression, expressionAttributeValues, expressionAttributeNames } = {}) {
  const before = (await getAll()).find((i) => i.PK === key.PK && i.SK === key.SK) || null;
  const names = { ...expressionAttributeNames };
  const values = { ...expressionAttributeValues };
  const sets = [];
  for (const [k, v] of Object.entries(attrs)) {
    const nameKey = `#${k}`;
    const valueKey = `:${k}`;
    names[nameKey] = k;
    values[valueKey] = v;
    sets.push(`${nameKey} = ${valueKey}`);
  }
  const res = await doc.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: key,
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: conditionExpression,
      ReturnValues: "ALL_NEW",
    })
  );
  await recordAudit({
    action: before ? "update" : "create",
    targetItemType: before?.itemType || res.Attributes?.itemType,
    targetKey: key,
    changes: diffFields(before, res.Attributes, Object.keys(attrs)),
  });
  await scanAll();
  return res.Attributes;
}

async function deleteItem(key, { conditionExpression, expressionAttributeValues } = {}) {
  const before = (await getAll()).find((i) => i.PK === key.PK && i.SK === key.SK) || null;
  await doc.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: key,
      ConditionExpression: conditionExpression,
      ExpressionAttributeValues: expressionAttributeValues,
    })
  );
  if (before) {
    const fields = Object.keys(before).filter((f) => f !== "PK" && f !== "SK");
    await recordAudit({
      action: "delete",
      targetItemType: before.itemType,
      targetKey: key,
      changes: diffFields(before, null, fields),
    });
  }
  await scanAll();
}

// items: array of { Put: {...} } | { Update: {...} } | { Delete: {...} } | { ConditionCheck: {...} }
// Each inner object omits TableName — added here for convenience.
async function transactWrite(items) {
  const before = await getAll();
  const beforeByKey = new Map(before.map((i) => [`${i.PK}#${i.SK}`, i]));
  const TransactItems = items.map((entry) => {
    const [op, params] = Object.entries(entry)[0];
    return { [op]: { TableName: TABLE, ...params } };
  });
  await doc.send(new TransactWriteCommand({ TransactItems }));

  // Audited the same way as the single-item equivalents above.
  for (const entry of items) {
    const [op, params] = Object.entries(entry)[0];
    if (op === "ConditionCheck") continue;
    const targetKey = op === "Put" ? { PK: params.Item.PK, SK: params.Item.SK } : params.Key;
    const prior = beforeByKey.get(`${targetKey.PK}#${targetKey.SK}`) || null;
    if (op === "Put") {
      const fields = new Set([...(prior ? Object.keys(prior) : []), ...Object.keys(params.Item)]);
      fields.delete("PK");
      fields.delete("SK");
      // eslint-disable-next-line no-await-in-loop
      await recordAudit({
        action: prior ? "update" : "create",
        targetItemType: params.Item.itemType,
        targetKey,
        changes: diffFields(prior, params.Item, [...fields]),
      });
    } else if (op === "Delete" && prior) {
      const fields = Object.keys(prior).filter((f) => f !== "PK" && f !== "SK");
      // eslint-disable-next-line no-await-in-loop
      await recordAudit({
        action: "delete",
        targetItemType: prior.itemType,
        targetKey,
        changes: diffFields(prior, null, fields),
      });
    } else if (op === "Update") {
      const attrs = attrsFromUpdateParams(params);
      // eslint-disable-next-line no-await-in-loop
      await recordAudit({
        action: prior ? "update" : "create",
        targetItemType: prior?.itemType || null,
        targetKey,
        changes: diffFields(prior, { ...prior, ...attrs }, Object.keys(attrs)),
      });
    }
  }
  await scanAll();
}

module.exports = {
  TABLE,
  getAll,
  scanAll,
  byItemType,
  byPKPrefix,
  getItem,
  putItem,
  putItemsBulk,
  updateItem,
  deleteItem,
  transactWrite,
};
