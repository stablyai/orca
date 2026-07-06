// Why: `gjc -p`/`gjc --print "<task>"` is Gajae Code's headless one-shot mode
// (runs the task and exits), not an interactive TUI pane. Recognize it so the
// foreground-process detector does not paint a short-lived headless run as a
// live agent session. Mirrors ante-headless-command.ts.

const GJC_HEADLESS_PRINT_FLAGS = new Set(['--print', '-p'])

function optionName(token: string): string {
  const eq = token.indexOf('=')
  return eq === -1 ? token : token.slice(0, eq)
}

function isGjcHeadlessPrintFlag(token: string): boolean {
  return GJC_HEADLESS_PRINT_FLAGS.has(optionName(token))
}

export function isGjcHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    if (isGjcHeadlessPrintFlag(tokens[index])) {
      return true
    }
  }
  return false
}
