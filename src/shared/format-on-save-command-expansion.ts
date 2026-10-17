/** Thrown when a path cannot be placed in the command without letting the shell reinterpret it. */
export class FormatOnSaveCommandError extends Error {}

export type FormatOnSaveTokenValues = {
  file: string
  relativeFile: string
}

export const FORMAT_ON_SAVE_FILE_TOKEN = '${file}'
export const FORMAT_ON_SAVE_RELATIVE_FILE_TOKEN = '${relativeFile}'

function tokenAt(command: string, index: number): string | null {
  if (command.startsWith(FORMAT_ON_SAVE_RELATIVE_FILE_TOKEN, index)) {
    return FORMAT_ON_SAVE_RELATIVE_FILE_TOKEN
  }
  return command.startsWith(FORMAT_ON_SAVE_FILE_TOKEN, index) ? FORMAT_ON_SAVE_FILE_TOKEN : null
}

function valueFor(token: string, values: FormatOnSaveTokenValues): string {
  if (token === FORMAT_ON_SAVE_RELATIVE_FILE_TOKEN) {
    // Why: a repo can contain a file named `--config=...`; `./` keeps it a path, not a flag.
    return values.relativeFile.startsWith('-') ? `./${values.relativeFile}` : values.relativeFile
  }
  return values.file
}

function assertNoNul(value: string): void {
  if (value.includes('\0')) {
    throw new FormatOnSaveCommandError('File path contains a NUL byte.')
  }
}

function singleQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`
}

function escapeForDoubleQuotes(value: string): string {
  return value.replace(/[\\"$`]/g, '\\$&')
}

const WORD_START_BEFORE_COMMENT = new Set([' ', '\t', '\n', ';', '&', '|', '('])

type PosixFrame = 'double' | 'paren'

/**
 * Substitutes tokens using the quoting state at each token, because a path
 * placed inside the user's own `"..."` must be escaped for double quotes, not
 * single-quoted (single quotes are literal there, so `$(...)` would still run).
 * Filenames come from cloned repositories and are attacker-controlled.
 */
function expandPosix(command: string, values: FormatOnSaveTokenValues): string {
  const frames: PosixFrame[] = []
  let out = ''
  let index = 0
  let heredocSeen = false

  const substitute = (token: string, quote: (value: string) => string): string => {
    if (heredocSeen) {
      // Why: an unquoted heredoc body still runs `$(...)`, and its quoting rules are not modelled here.
      throw new FormatOnSaveCommandError('${file} cannot follow a heredoc in the format command.')
    }
    const value = valueFor(token, values)
    assertNoNul(value)
    return quote(value)
  }

  while (index < command.length) {
    const char = command[index]
    const token = char === '$' ? tokenAt(command, index) : null

    if (frames.at(-1) === 'double') {
      if (token) {
        out += substitute(token, escapeForDoubleQuotes)
        index += token.length
      } else if (char === '\\') {
        // Why: every char after a backslash is either escaped or literal-and-inert in double quotes.
        out += command.slice(index, index + 2)
        index += 2
      } else if (char === '"') {
        frames.pop()
        out += char
        index++
      } else if (char === '$' && command[index + 1] === '(') {
        frames.push('paren')
        out += '$('
        index += 2
      } else if (char === '`') {
        index = copyBacktickSpan(command, index, (span) => (out += span))
      } else {
        out += char
        index++
      }
      continue
    }

    if (token) {
      out += substitute(token, singleQuote)
      index += token.length
      continue
    }

    switch (char) {
      case '\\':
        out += command.slice(index, index + 2)
        index += 2
        break
      case "'": {
        const end = command.indexOf("'", index + 1)
        if (end === -1) {
          throw new FormatOnSaveCommandError('Unterminated single quote in the format command.')
        }
        out += `'${replaceTokensInSingleQuotes(command.slice(index + 1, end), substitute)}'`
        index = end + 1
        break
      }
      case '"':
        frames.push('double')
        out += char
        index++
        break
      case '$':
        if (command[index + 1] === "'") {
          index = copyAnsiCQuotedSpan(command, index, (span) => (out += span))
        } else if (command[index + 1] === '(') {
          frames.push('paren')
          out += '$('
          index += 2
        } else {
          out += char
          index++
        }
        break
      case '(':
        frames.push('paren')
        out += char
        index++
        break
      case ')':
        if (frames.at(-1) === 'paren') {
          frames.pop()
        }
        out += char
        index++
        break
      case '`':
        index = copyBacktickSpan(command, index, (span) => (out += span))
        break
      case '<':
        if (command[index + 1] === '<' && command[index + 2] !== '<') {
          heredocSeen = true
        }
        out += char
        index++
        break
      case '#': {
        const previous = command[index - 1]
        if (previous === undefined || WORD_START_BEFORE_COMMENT.has(previous)) {
          // Why: a newline inside the value would end the comment and run the rest, so comments keep the token unexpanded.
          const lineEnd = command.indexOf('\n', index)
          const end = lineEnd === -1 ? command.length : lineEnd
          out += command.slice(index, end)
          index = end
        } else {
          out += char
          index++
        }
        break
      }
      default:
        out += char
        index++
    }
  }
  return out
}

function replaceTokensInSingleQuotes(
  text: string,
  substitute: (token: string, quote: (value: string) => string) => string
): string {
  let out = ''
  let index = 0
  while (index < text.length) {
    const token = text[index] === '$' ? tokenAt(text, index) : null
    if (token) {
      // Why: close the user's quote, emit a fully quoted word, then reopen — adjacent words concatenate.
      out += `'${substitute(token, singleQuote)}'`
      index += token.length
    } else {
      out += text[index]
      index++
    }
  }
  return out
}

/** Backtick spans and `$'...'` strings escape differently, so a token inside one is rejected rather than guessed. */
function copyBacktickSpan(command: string, start: number, emit: (span: string) => void): number {
  let end = start + 1
  while (end < command.length && command[end] !== '`') {
    end += command[end] === '\\' ? 2 : 1
  }
  const span = command.slice(start, end + 1)
  rejectTokens(span)
  emit(span)
  return end + 1
}

function copyAnsiCQuotedSpan(command: string, start: number, emit: (span: string) => void): number {
  let end = start + 2
  while (end < command.length && command[end] !== "'") {
    end += command[end] === '\\' ? 2 : 1
  }
  const span = command.slice(start, end + 1)
  rejectTokens(span)
  emit(span)
  return end + 1
}

function rejectTokens(span: string): void {
  if (
    span.includes(FORMAT_ON_SAVE_FILE_TOKEN) ||
    span.includes(FORMAT_ON_SAVE_RELATIVE_FILE_TOKEN)
  ) {
    throw new FormatOnSaveCommandError(
      "A path placeholder cannot be used inside backticks or $'...' in the format command."
    )
  }
}

/**
 * cmd.exe expands `%VAR%` even inside double quotes and offers no reliable
 * escape for it on a command line, so a path holding `%` (or any character
 * that cannot live in a quoted argument) is refused instead of guessed at.
 */
function expandWindows(command: string, values: FormatOnSaveTokenValues): string {
  let out = ''
  let inQuotes = false
  let index = 0

  while (index < command.length) {
    const char = command[index]
    const token = char === '$' ? tokenAt(command, index) : null

    if (token) {
      const value = valueFor(token, values)
      assertQuotableForCmd(value)
      out += inQuotes ? value : `"${value}"`
      index += token.length
      continue
    }
    if (char === '^' && !inQuotes) {
      out += command.slice(index, index + 2)
      index += 2
      continue
    }
    if (char === '"') {
      inQuotes = !inQuotes
    }
    out += char
    index++
  }
  return out
}

function assertQuotableForCmd(value: string): void {
  assertNoNul(value)
  if (/["%\r\n]/.test(value)) {
    throw new FormatOnSaveCommandError(
      'File path contains a character (", %, or a line break) that cmd.exe cannot pass safely.'
    )
  }
}

export function expandCommandTokens(
  command: string,
  values: FormatOnSaveTokenValues,
  platform: NodeJS.Platform
): string {
  return platform === 'win32' ? expandWindows(command, values) : expandPosix(command, values)
}

export function quoteForShell(value: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    assertQuotableForCmd(value)
    return `"${value}"`
  }
  assertNoNul(value)
  return singleQuote(value)
}
