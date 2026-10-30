// Answer version/help probes and refuse app-server so fake Codex records only real agent spawns.
export const FAKE_CODEX_LAUNCH_PROBES_SOURCE = `
if (process.argv.length === 3 && process.argv[2] === '--version') {
  require('node:fs').writeSync(1, 'codex-cli 0.0.0\\n')
  process.exit(0)
}
if (process.argv.slice(2).includes('app-server')) {
  process.stderr.write("error: unrecognized subcommand 'app-server'\\n")
  process.exit(2)
}
if (process.argv.slice(2).includes('--help')) {
  process.stdout.write('Usage: codex [OPTIONS] [PROMPT]\\n')
  process.exit(0)
}
`
