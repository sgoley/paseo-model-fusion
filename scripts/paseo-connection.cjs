const { realpathSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { homedir } = require("node:os");
const { execFileSync } = require("node:child_process");
exports.connect = async () => {
  const root = process.env.PASEO_CLI_ROOT || dirname(dirname(realpathSync(execFileSync("which", ["paseo"], { encoding: "utf8" }).trim())));
  const { connectToDaemon } = await import(require("node:url").pathToFileURL(join(root, "dist/utils/client.js")).href);
  const driver = await connectToDaemon({ target: { kind: "instance", home: process.env.PASEO_HOME || join(homedir(), ".paseo") }, timeout: 20000 });
  const { createPaseoApi } = require("@getpaseo/client");
  return { driver, api: createPaseoApi(driver) };
};
