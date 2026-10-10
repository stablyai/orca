/**
 * How long a command line may get before `CreateProcess` refuses it.
 *
 * Windows caps a command line at 32767 characters, and *everything* shares that
 * one budget: the binary, `wsl.exe -d <distro> --exec`, the login-shell wrapper
 * and the payload. So the number only means anything when it is measured on the
 * FINISHED line. Two shipped defects came from measuring a part instead: a
 * script-only threshold in the WSL runner, where a multi-KB login PATH pushed a
 * legal-looking script over the real limit, and count-only chunking of bulk git
 * pathspecs, where the login-shell wrapper tripled the line behind our back.
 *
 * The 2767-character margin absorbs what we do not model exactly (the distro
 * name, libuv's requoting of the outer argv).
 */
export const MAX_COMMAND_LINE_CHARS = 30_000

/**
 * What `CreateProcess` will count.
 *
 * libuv escapes every `"` and doubles a backslash run before a quote, so a
 * quote-dense script costs more than its length. Charging one extra character
 * per `"` or `\\` keeps the estimate on the safe side of the cap; an earlier
 * version claimed to over-count and in fact under-counted, which put a
 * quote-heavy ~26KB script on argv and over the real limit.
 */
export function commandLineLength(args: readonly string[]): number {
  let total = 0
  for (const arg of args) {
    total += arg.length + 3 + countEscapes(arg)
  }
  return total
}

/** One escape per this many characters is where seeking stops paying off. */
const DENSE_ESCAPE_RATIO = 4
/** Leading escapes alone must not condemn a long plain tail to a full scan. */
const DENSE_ESCAPE_GRACE = 256

/**
 * Count `"` and `\\` in an argument.
 *
 * `indexOf` skips plain runs with a native search, so the cost tracks the number
 * of escapes rather than the length of the argument — which is what the WSL
 * runner hands us: one multi-KB script with almost no escapes in it. Past the
 * density where seeking each escape costs more than reading every character,
 * a plain scan finishes the rest; that is the quote-dense script's shape.
 */
function countEscapes(arg: string): number {
  let count = 0
  let scanFrom = 0
  let quote = arg.indexOf('"')
  let slash = arg.indexOf('\\')
  while (quote !== -1 || slash !== -1) {
    const at = slash === -1 || (quote !== -1 && quote < slash) ? quote : slash
    if (at === quote) {
      quote = arg.indexOf('"', at + 1)
    } else {
      slash = arg.indexOf('\\', at + 1)
    }
    count += 1
    scanFrom = at + 1
    if (count * DENSE_ESCAPE_RATIO > at + DENSE_ESCAPE_GRACE) {
      break
    }
  }
  if (quote === -1 && slash === -1) {
    return count
  }
  for (let index = scanFrom; index < arg.length; index += 1) {
    const code = arg.charCodeAt(index)
    if (code === 34 || code === 92) {
      count += 1
    }
  }
  return count
}
