const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");
const config = require("../config");

// When DYNAMODB_ENDPOINT is set (DynamoDB Local), fake credentials are
// required by the SDK but never actually checked by DynamoDB Local.
// When it's unset, this falls through to real AWS using the standard
// credential chain (aws configure, env vars, IAM role, etc.) — pointing
// this app at real AWS is purely an env var change, not a code change.
const client = new DynamoDBClient({
  region: config.awsRegion,
  endpoint: config.dynamodbEndpoint,
  ...(config.dynamodbEndpoint
    ? { credentials: { accessKeyId: "local", secretAccessKey: "local" } }
    : {}),
});

const doc = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

module.exports = { client, doc };
