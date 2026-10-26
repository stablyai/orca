/** Measure the finished Windows command against the 32767-character limit, including binary, WSL/login wrappers and payload.
 * Partial/count-only budgets missed large login PATH and wrapper expansion; reserve 2767 characters for distro names and outer libuv quoting. */
export const MAX_COMMAND_LINE_CHARS = 30_000

/** Conservatively charge extra for quotes/backslashes that libuv escapes; ignoring requoting let quote-heavy ~26KB scripts exceed CreateProcess limits. */
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

/** Seek sparse escapes natively for long WSL scripts; switch to a plain scan when escape density makes repeated searches costlier. */
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
