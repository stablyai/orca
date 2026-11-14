// Reads PowerShell in its own quoting, so its strings, escapes and comments can't pass for commands.

// The common pattern's PowerShell launch options: flags, and options that take one value.
const POWERSHELL_FLAGS = new Set(['-mta', '-nologo', '-noninteractive', '-noprofile', '-sta'])
const POWERSHELL_OPTIONS_WITH_VALUE = new Set([
  '-configurationname',
  '-executionpolicy',
  '-inputformat',
  '-outputformat',
  '-version',
  '-windowstyle',
  '-workingdirectory'
])
// Characters that open or close text in POSIX analysis; they never survive inside a literal.
const QUOTE_CHARACTERS = /['"`]/gu

/** A PowerShell literal as POSIX analysis should see it: one quoted word, its text kept. */
function neutralLiteral(text: string): string {
  return `'${text.replace(QUOTE_CHARACTERS, '')}'`
}

/** PowerShell's script read in PowerShell's own quoting, with every string, here-string and comment
 *  rewritten as POSIX-neutral text. Null for input it can't read whole, which then opens nothing. */
export function powershellAnalysisScript(script: string): string | null {
  let out = ''
  let index = 0
  const at = (offset = 0): string => script[index + offset] ?? ''
  while (index < script.length) {
    const char = at()
    // Here-strings run from `@'` or `@"` at a line's end to the same quote and `@` opening a line.
    if (
      char === '@' &&
      (at(1) === "'" || at(1) === '"') &&
      /^\r?\n/u.test(script.slice(index + 2))
    ) {
      const quote = at(1)
      const close = new RegExp(`\\r?\\n${quote}@`, 'u').exec(script.slice(index + 2))
      if (!close) {
        return null
      }
      out += neutralLiteral(script.slice(index + 2, index + 2 + close.index))
      index += 2 + close.index + close[0].length
      continue
    }
    if (char === "'") {
      // Single quotes: `''` is a quote and a backtick is literal.
      let text = ''
      index += 1
      for (;;) {
        if (index >= script.length) {
          return null
        }
        if (at() === "'" && at(1) === "'") {
          text += "'"
          index += 2
        } else if (at() === "'") {
          index += 1
          break
        } else {
          text += at()
          index += 1
        }
      }
      out += neutralLiteral(text)
      continue
    }
    if (char === '"') {
      // Double quotes: a backtick escapes the next character and `""` is a quote. A `$(…)` inside
      // still runs, but stays text here: a create inside one is missed rather than guessed at.
      let text = ''
      index += 1
      for (;;) {
        if (index >= script.length) {
          return null
        }
        if (at() === '`') {
          text += at(1)
          index += 2
        } else if (at() === '"' && at(1) === '"') {
          text += '"'
          index += 2
        } else if (at() === '"') {
          index += 1
          break
        } else {
          text += at()
          index += 1
        }
      }
      out += neutralLiteral(text)
      continue
    }
    if (char === '<' && at(1) === '#') {
      const end = script.indexOf('#>', index + 2)
      if (end === -1) {
        return null
      }
      out += ' '
      index = end + 2
      continue
    }
    if (char === '#' && (index === 0 || /[\s;|&(]/u.test(script[index - 1] ?? ''))) {
      while (index < script.length && at() !== '\n') {
        index += 1
      }
      continue
    }
    if (char === '`') {
      // Bare text: an escaped character is never a separator or a quote; a line end continues.
      out += at(1) === '\n' || at(1) === '\r' ? ' ' : '_'
      index += at(1) === '\r' && at(2) === '\n' ? 3 : 2
      continue
    }
    out += char
    index += 1
  }
  return out
}

/** The script a PowerShell launch runs, from its argv. Null when it isn't a plain `-Command`. */
export function powershellInvocationScript(argv: readonly string[]): string | null {
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index]!.toLowerCase()
    if (option === '-command' || option === '-c') {
      const script = argv.slice(index + 1).join(' ')
      return script ? powershellAnalysisScript(script) : null
    }
    if (POWERSHELL_OPTIONS_WITH_VALUE.has(option)) {
      index += 1
    } else if (!POWERSHELL_FLAGS.has(option)) {
      // -File, -EncodedCommand and anything unknown: nothing here to read as a command.
      return null
    }
  }
  return null
}
