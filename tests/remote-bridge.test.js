const test = require("node:test");
const assert = require("node:assert/strict");
const { loadApiKey, getProjectName, getGitBranch } = require("../scripts/remote-bridge");

test("Remote Bridge exports required helpers", () => {
  assert.equal(typeof loadApiKey, "function");
  assert.equal(typeof getProjectName, "function");
  assert.equal(typeof getGitBranch, "function");

  const name = getProjectName();
  assert.ok(typeof name === "string" && name.length > 0);
});
