import { spawnSync } from "node:child_process";

const herdrBin = process.env.HERDR_BIN_PATH ?? "herdr";
const pluginId = process.env.HERDR_PLUGIN_ID ?? "claude-handoff";

const res = spawnSync(
  herdrBin,
  ["plugin", "pane", "open", "--plugin", pluginId, "--entrypoint", "picker"],
  { stdio: "inherit" },
);

if (res.error) {
  process.stderr.write(`Failed to open picker pane: ${res.error.message}\n`);
  process.exit(1);
}

process.exit(res.status ?? 0);
