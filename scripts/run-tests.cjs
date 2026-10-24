const { readdirSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
let failed = false;
for (const file of readdirSync("tests").filter((file) => file.endsWith(".test.cjs"))) {
  const result = spawnSync(process.execPath, ["tests/" + file], { stdio: "inherit" });
  if (result.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
