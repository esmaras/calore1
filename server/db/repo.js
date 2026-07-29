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

const TABLE = config.dynamodbTable;

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
  await doc.send(new PutCommand({ TableName: TABLE, Item: item }));
  await scanAll();
  return item;
}

// Writes many items without re-scanning the table between each one (a
// single putItem() per row would mean one full Scan per row — fine for a
// single edit, wasteful for bulk writes like migration or the transitional
// whole-blob save). Refreshes the cache once at the end instead.
async function putItemsBulk(items) {
  for (const item of items) {
    // eslint-disable-next-line no-await-in-loop
    await doc.send(new PutCommand({ TableName: TABLE, Item: item }));
  }
  await scanAll();
  return items;
}

// Partial attribute update. `attrs` is a flat object of top-level
// attributes to set (never PK/SK). Returns the updated item.
async function updateItem(key, attrs, { conditionExpression, expressionAttributeValues, expressionAttributeNames } = {}) {
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
  await scanAll();
  return res.Attributes;
}

async function deleteItem(key, { conditionExpression, expressionAttributeValues } = {}) {
  await doc.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: key,
      ConditionExpression: conditionExpression,
      ExpressionAttributeValues: expressionAttributeValues,
    })
  );
  await scanAll();
}

// items: array of { Put: {...} } | { Update: {...} } | { Delete: {...} } | { ConditionCheck: {...} }
// Each inner object omits TableName — added here for convenience.
async function transactWrite(items) {
  const TransactItems = items.map((entry) => {
    const [op, params] = Object.entries(entry)[0];
    return { [op]: { TableName: TABLE, ...params } };
  });
  await doc.send(new TransactWriteCommand({ TransactItems }));
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
