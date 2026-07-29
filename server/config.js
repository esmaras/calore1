function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

module.exports = {
  port: Number(process.env.PORT || 4173),
  awsRegion: process.env.AWS_REGION || "us-east-1",
  dynamodbEndpoint: process.env.DYNAMODB_ENDPOINT || undefined, // undefined = talk to real AWS
  dynamodbTable: process.env.DYNAMODB_TABLE || "calore1-app",
  get sessionSecret() {
    return required("SESSION_SECRET");
  },
  isProduction: process.env.NODE_ENV === "production",
};
