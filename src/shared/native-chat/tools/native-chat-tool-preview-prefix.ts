export const MAX_TOOL_PREVIEW_LENGTH = 80
const SHORT_INPUT_LENGTH = 160

// One extra normalized code unit proves truncation and inequality with an 80-unit label.
export function collapsedToolInputPrefix(input: string): string {
  if (input.length <= SHORT_INPUT_LENGTH) {
    return input.replace(/\s+/g, ' ').trim()
  }
  let collapsed = ''
  let pendingSpace = false
  const whitespace = /\s+/y
  for (let index = 0; index < input.length;) {
    whitespace.lastIndex = index
    if (whitespace.test(input)) {
      index = whitespace.lastIndex
      pendingSpace = collapsed.length > 0
      continue
    }
    if (pendingSpace) {
      collapsed += ' '
      pendingSpace = false
    }
    collapsed += input[index++]
    if (collapsed.length > MAX_TOOL_PREVIEW_LENGTH) {
      return collapsed
    }
  }
  return collapsed
}

/** Strip login-shell wrappers only when the entire remainder is one quoted shell word. Pipelines/unpaired quotes stay literal.
 * Run before clipping: the closing quote proves the wrapper and would be lost from a bounded prefix. */
const LOGIN_SHELL_PREFIX =
  /^\s*(?:[^'"]*[\\/])?(?:ba|z|k|da|fi)?sh(?:\.exe)?\s+-[a-zA-Z]*c\s+(?=['"])/
const DOUBLE_QUOTED_RUN = /[^"\\]+/y
const DOUBLE_QUOTE_ESCAPABLE = '$`"\\\n'
const PLAIN_WORD_CHAR = /[\w@%+=:,./-]/

export function unwrapLoginShellCommand(command: string): string {
  const prefix = LOGIN_SHELL_PREFIX.exec(command)
  return prefix
    ? (decodeQuotedShellWord(command.slice(prefix[0].length).trimEnd()) ?? command)
    : command
}

// Agents join argv by switching quote styles mid-word (`"a'b"'$'`), so undo POSIX quoting, not just the outer pair.
function decodeQuotedShellWord(word: string): string | null {
  let decoded = ''
  let index = 0
  while (index < word.length) {
    const char = word[index]
    if (char === "'") {
      const end = word.indexOf("'", index + 1)
      if (end === -1) {
        return null
      }
      decoded += word.slice(index + 1, end)
      index = end + 1
    } else if (char === '"') {
      index += 1
      for (;;) {
        DOUBLE_QUOTED_RUN.lastIndex = index
        if (DOUBLE_QUOTED_RUN.test(word)) {
          decoded += word.slice(index, DOUBLE_QUOTED_RUN.lastIndex)
          index = DOUBLE_QUOTED_RUN.lastIndex
        }
        if (index >= word.length) {
          return null
        }
        if (word[index] === '"') {
          index += 1
          break
        }
        const next = word[index + 1]
        if (next !== undefined && DOUBLE_QUOTE_ESCAPABLE.includes(next)) {
          // A backslash-newline inside double quotes is a line continuation.
          decoded += next === '\n' ? '' : next
          index += 2
        } else {
          decoded += '\\'
          index += 1
        }
      }
    } else if (char === '\\' && index + 1 < word.length) {
      decoded += word[index + 1] === '\n' ? '' : word[index + 1]
      index += 2
    } else if (PLAIN_WORD_CHAR.test(char)) {
      decoded += char
      index += 1
    } else {
      return null
    }
  }
  return decoded
}
