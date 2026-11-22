import { optionName } from './print-mode-headless-command'

// Prompt/target flags select one-shot runPrompt (ZCode run.ts); JSON/output-format flags affect presentation and do not imply headless.
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
