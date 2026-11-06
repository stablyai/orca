import { nativeChatFullCommand } from './native-chat-tool-input-text'

// Decodes the script a shell tool call ran into POSIX-readable text for command analysis. PowerShell
// is lexed in its own quoting first, so its strings, escapes and comments can't pass for commands.

const SHELL_PROGRAM = /^(?:ba|z|k|da|fi)?sh(?:\.exe)?$/iu
const SHELL_SCRIPT_FLAG = /^-[a-zA-Z]*c$/u
const POWERSHELL_PROGRAM = /^(?:pwsh|powershell)(?:\.exe)?$/iu
const CMD_PROGRAM = /^cmd(?:\.exe)?$/iu
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
const CMD_WRAPPER = /^(?:\/d\s+)?(?:\/s\s+)?\/c\s+([\s\S]+)$/iu
// Characters that open or close text in POSIX analysis; they never survive inside a literal.
const QUOTE_CHARACTERS = /['"`]/gu

function programName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? ''
}

function argvCommand(input: unknown): readonly string[] | null {
  let value = input
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const argv =
    'command' in value && Array.isArray(value.command)
      ? value.command
      : 'cmd' in value
        ? value.cmd
        : null
  return Array.isArray(argv) && argv.every((part) => typeof part === 'string') ? argv : null
}

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
function powershellInvocationScript(argv: readonly string[]): string | null {
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

/** A Windows command line's words, undoing its own quoting: `"…"` (with `""`), `'…'` (with `''`). */
function commandLineWords(command: string): string[] | null {
  const words: string[] = []
  let index = 0
  while (index < command.length) {
    while (/\s/u.test(command[index] ?? '')) {
      index += 1
    }
    if (index >= command.length) {
      break
    }
    const quote = command[index]
    if (quote === '"' || quote === "'") {
      let word = ''
      index += 1
      for (;;) {
        if (index >= command.length) {
          return null
        }
        if (command[index] === quote && command[index + 1] === quote) {
          word += quote
          index += 2
        } else if (command[index] === quote) {
          index += 1
          break
        } else {
          word += command[index]
          index += 1
        }
      }
      words.push(word)
    } else {
      const start = index
      while (index < command.length && !/\s/u.test(command[index]!)) {
        index += 1
      }
      words.push(command.slice(start, index))
    }
  }
  return words
}

/** The script a shell tool call ran, as POSIX-readable text; null when there is none to read.
 *  An argv `[sh, -lc, script]` keeps its script whole, since joining it would leave the command
 *  after the wrapper instead of at a command start. */
export function nativeChatToolCallScript(name: string, input: unknown): string | null {
  const argv = argvCommand(input)
  const program = programName(argv?.[0] ?? '')
  if (argv && POWERSHELL_PROGRAM.test(program)) {
    return powershellInvocationScript(argv)
  }
  if (argv?.length === 3 && SHELL_PROGRAM.test(program) && SHELL_SCRIPT_FLAG.test(argv[1]!)) {
    return argv[2]!
  }
  if (argv?.length === 3 && CMD_PROGRAM.test(program) && /^\/c$/iu.test(argv[1]!)) {
    return argv[2]!
  }
  const command = nativeChatFullCommand(input)
  if (command === null) {
    return null
  }
  const first = /^\s*(?:"([^"]+)"|(\S+))/u.exec(command)
  const launched = programName(first?.[1] ?? first?.[2] ?? '')
  if (POWERSHELL_PROGRAM.test(launched)) {
    // Codex on Windows records `"C:\…\pwsh.exe" -Command 'script'`.
    const words = commandLineWords(command)
    return words ? powershellInvocationScript(words) : null
  }
  if (CMD_PROGRAM.test(launched) && first) {
    const wrapped = CMD_WRAPPER.exec(command.slice(first.index + first[0].length).trim())
    if (wrapped) {
      const script = wrapped[1]!.trim()
      return script.length >= 2 && script.startsWith('"') && script.endsWith('"')
        ? script.slice(1, -1)
        : script
    }
  }
  // A tool that is PowerShell itself runs any other command as a PowerShell script.
  if (name.trim().toLowerCase() === 'powershell') {
    return powershellAnalysisScript(command)
  }
  return command
}
