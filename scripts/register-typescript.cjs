const fs = require("node:fs");
const ts = require("typescript");
// Test-only loader: run server sources with Node's test runner without a runtime dependency.
require.extensions[".ts"] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
    fileName: filename,
  });
  module._compile(outputText, filename);
};
