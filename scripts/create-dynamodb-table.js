#!/usr/bin/env node
// Idempotent table creation. Safe to run repeatedly (against DynamoDB
// Local during development, or against real AWS once DYNAMODB_ENDPOINT
// is unset and real credentials/region are in play).

const { CreateTableCommand, DescribeTableCommand } = require("@aws-sdk/client-dynamodb");
const { client } = require("../server/db/client");
const config = require("../server/config");

async function main() {
  const tableName = config.dynamodbTable;

  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    console.log(`Table "${tableName}" already exists — nothing to do.`);
    return;
  } catch (err) {
    if (err.name !== "ResourceNotFoundException") throw err;
  }

  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
    })
  );
  console.log(`Created table "${tableName}".`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
