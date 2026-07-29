const app = require("./app");
const config = require("./config");

app.listen(config.port, () => {
  console.log(`Calore 1 campaign tracker running at http://localhost:${config.port}`);
});
