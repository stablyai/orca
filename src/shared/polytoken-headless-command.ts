// Why: `polytoken exec` is the one-shot prompt runner and `polytoken daemon` a foreground
// service; neither hosts the TUI, so a pane running them must not claim interactive
// Polytoken status. Global options that take a value are skipped so `--working-dir x exec`
// still resolves to the subcommand.
const GLOBAL_OPTIONS_WITH_VALUE = new Set(['--config-dir', '--working-dir'])
const HEADLESS_SUBCOMMANDS = new Set(['exec', 'daemon'])

export function isPolytokenHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      return false
    }
    if (GLOBAL_OPTIONS_WITH_VALUE.has(token)) {
      index += 1
      continue
    }
    if (token.startsWith('-')) {
      continue
    }
    return HEADLESS_SUBCOMMANDS.has(token)
  }
  return false
}
