/**
 * Answers the non-session Codex invocations Orca makes before a launch, so a fake
 * Codex only records the real agent spawn: the shared app-server is refused, and the
 * `--no-daemon` support probe (`codex --help`) exits without advertising the flag.
 */
export const FAKE_CODEX_LAUNCH_PROBES_SOURCE = `
if (process.argv.slice(2).includes('app-server')) {
  process.stderr.write("error: unrecognized subcommand 'app-server'\\n")
  process.exit(2)
}
if (process.argv.slice(2).includes('--help')) {
  process.stdout.write('Usage: codex [OPTIONS] [PROMPT]\\n')
  process.exit(0)
}
`
