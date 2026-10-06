#!/usr/bin/env node
// Print the effective binding after shell startup, and keep simultaneous terminals alive.
const { basename } = require('node:path')
const agent = basename(process.argv[1])
if (process.argv.includes('--version')) {
  console.log(agent === 'claude' ? '2.1.0 (Claude Code)' : 'codex-cli 0.158.0')
  process.exit(0)
}
if (process.argv.includes('--help')) {
  console.log(`Usage: ${agent} [--no-daemon]`)
  process.exit(0)
}
console.log(
  `PROFILE_AGENT ${JSON.stringify({
    agent,
    cwd: process.cwd(),
    home: agent === 'claude' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME,
    argv: process.argv.slice(2)
  })}`
)
setInterval(() => {}, 1000)
