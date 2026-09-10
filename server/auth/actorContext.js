// Lets server/db/repo.js know *who* is making a write without threading a
// user object through every route/service call — app.js wraps each request
// in `run()` once (see the middleware there), and repo.js reads it back via
// getActor() at write time to attribute audit log entries. Outside of a
// request (migrations, one-off scripts), getActor() returns null and
// callers attribute the write to "system".
const { AsyncLocalStorage } = require("async_hooks");

const storage = new AsyncLocalStorage();

function run(actor, fn) {
  return storage.run(actor, fn);
}

function getActor() {
  return storage.getStore() || null;
}

module.exports = { run, getActor };
