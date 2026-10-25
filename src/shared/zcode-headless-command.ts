import { optionName } from './print-mode-headless-command'

// Why: ZCode dispatches headlessly on `typeof values.prompt === "string"` or an explicit
// `--target` (apps/zcode-cli/packages/cli/src/run.ts) — both run one prompt through
// `runPrompt` and exit, so the pane never hosts the interactive TUI. `--json` and
// `--output-format` are presentation flags on either path, so neither implies headless.
const ZCODE_HEADLESS_FLAGS: ReadonlySet<string> = new Set(['-p', '--prompt', '--target'])

export function isZCodeHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    // Why: `--` ends option parsing, so a later `--prompt`-looking token is a value, not a flag.
    if (tokens[index] === '--') {
      return false
    }
    if (ZCODE_HEADLESS_FLAGS.has(optionName(tokens[index]))) {
      return true
    }
  }
  return false
}
