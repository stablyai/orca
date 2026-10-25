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

/** `/bin/zsh -lc "git status"` is how the agent reaches a shell, not what it
 *  ran. Every such row opens with the same fourteen characters, which is the
 *  width the command itself needed. Strip the wrapper when the whole remainder
 *  is one quoted string; anything else (a pipeline into the wrapper, an unpaired
 *  quote) is left exactly as the agent wrote it.
 *
 *  Must run BEFORE any truncation: the closing quote is what proves the match,
 *  and an 80-character prefix has already dropped it. */
const LOGIN_SHELL_COMMAND =
  /^\s*(?:.*[\\/])?(?:ba|z|k|da|fi)?sh(?:\.exe)?\s+-[a-zA-Z]*c\s+(['"])([\s\S]*)\1\s*$/

export function unwrapLoginShellCommand(command: string): string {
  return LOGIN_SHELL_COMMAND.exec(command)?.[2] ?? command
}
