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
// Characters a POSIX argv join leaves bare; anything else bare is shell syntax, not a word.
const PLAIN_WORD_CHAR = /[\w@%+=:,./\]-]/

export function unwrapLoginShellCommand(command: string): string {
  const prefix = LOGIN_SHELL_PREFIX.exec(command)
  const words = prefix ? posixShellWords(command.slice(prefix[0].length).trimEnd()) : null
  return words?.length === 1 ? words[0]! : command
}

/** The words of a POSIX-quoted argv, as agents join it: split at bare whitespace, with each word's
 *  pieces undone and joined, since joins switch quote styles mid-word (`"a'b"'$'`). Null for text
 *  that is more than a quoted argv, such as a pipeline or an unpaired quote. */
export function posixShellWords(text: string): string[] | null {
  const words: string[] = []
  let word: string | null = null
  let index = 0
  while (index < text.length) {
    const char = text[index]!
    if (char === ' ' || char === '\t') {
      if (word !== null) {
        words.push(word)
      }
      word = null
      index += 1
      continue
    }
    word ??= ''
    if (char === "'") {
      const end = text.indexOf("'", index + 1)
      if (end === -1) {
        return null
      }
      word += text.slice(index + 1, end)
      index = end + 1
    } else if (char === '"') {
      index += 1
      for (;;) {
        DOUBLE_QUOTED_RUN.lastIndex = index
        if (DOUBLE_QUOTED_RUN.test(text)) {
          word += text.slice(index, DOUBLE_QUOTED_RUN.lastIndex)
          index = DOUBLE_QUOTED_RUN.lastIndex
        }
        if (index >= text.length) {
          return null
        }
        if (text[index] === '"') {
          index += 1
          break
        }
        const next = text[index + 1]
        if (next !== undefined && DOUBLE_QUOTE_ESCAPABLE.includes(next)) {
          // A backslash-newline inside double quotes is a line continuation.
          word += next === '\n' ? '' : next
          index += 2
        } else {
          word += '\\'
          index += 1
        }
      }
    } else if (char === '\\' && index + 1 < text.length) {
      word += text[index + 1] === '\n' ? '' : text[index + 1]
      index += 2
    } else if (PLAIN_WORD_CHAR.test(char)) {
      word += char
      index += 1
    } else {
      return null
    }
  }
  if (word !== null) {
    words.push(word)
  }
  return words
}
