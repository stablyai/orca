/**
 * Keystroke model of hlissner/zsh-autopair, the line-editor plugin that corrupted #18059.
 *
 * Orca delivers a single-line startup command as keystrokes, so every pair-inserting widget bound
 * in the user's shell rewrites it before the shell parses it. This returns the buffer the user's
 * zle holds once Orca has typed `keystrokes` into it (input stops at the submit newline), which is
 * what the shell actually executes.
 *
 * Transcribed from autopair.zsh (pairs, left/right boundary regexes, `can-pair`, `can-skip`).
 * The model is anchored by `ZSH_AUTOPAIR_REPORTED_18059_CORRUPTION` below: any edit to it must keep
 * reproducing the corruption from the issue report, which is what makes the round-trip assertions
 * in typed-setup-command-line-editor-safety.test.ts trustworthy.
 */
const AUTOPAIR_PAIRS: Record<string, string> = {
  '`': '`',
  "'": "'",
  '"': '"',
  '{': '}',
  '[': ']',
  '(': ')',
  ' ': ' '
}
const AUTOPAIR_OPENERS: Record<string, string> = { '}': '{', ']': '[', ')': '(' }
const AUTOPAIR_LEFT_BOUNDS: Record<string, RegExp> = {
  all: /[.:/\\!]$/,
  quotes: /[\]})a-zA-Z0-9]$/,
  spaces: /[^{([]$/,
  '`': /`$/,
  '"': /"$/,
  "'": /'$/
}
const AUTOPAIR_RIGHT_BOUNDS: Record<string, RegExp> = {
  all: /^[[{(<,.:?/%$!a-zA-Z0-9]/,
  quotes: /^[a-zA-Z0-9]/,
  spaces: /^[^\]})]/
}

export function typeThroughZshAutopair(keystrokes: string): string {
  let left = ''
  let right = ''
  const count = (text: string, char: string): number => text.split(char).length - 1
  const balanced = (open: string, close: string): boolean => {
    const l = left.replaceAll(`\\${open}`, '')
    const r = right.replaceAll(`\\${close}`, '')
    const lCount = count(l, open)
    const rCount = count(r, close)
    if (lCount === 0 && rCount === 0) {
      return true
    }
    if (open === ' ') {
      const match = /[^'"]([ \t]+)$/.exec(left)
      return Boolean(match && right.startsWith(match[1]))
    }
    if (open === close) {
      return lCount === rCount || (lCount + rCount) % 2 === 0
    }
    return Math.max(0, lCount - count(l, close)) >= rCount - count(r, open)
  }
  const nextToBoundary = (key: string): boolean => {
    const group = `'"\``.includes(key) ? 'quotes' : key === ' ' ? 'spaces' : 'braces'
    return ['all', group, key].some(
      (name) =>
        Boolean(AUTOPAIR_LEFT_BOUNDS[name]?.test(left)) ||
        Boolean(AUTOPAIR_RIGHT_BOUNDS[name]?.test(right))
    )
  }
  const canPair = (key: string): boolean => {
    const close = AUTOPAIR_PAIRS[key]
    if (close !== ' ' ? !balanced(key, close) : /^[ \t]*$/.test(right)) {
      return false
    }
    return !nextToBoundary(key)
  }
  const canSkip = (open: string, close: string): boolean => {
    if (!left || (open === close && (open === ' ' || !balanced(open, close)))) {
      return false
    }
    return right[0] === close && !left.endsWith('\\')
  }
  for (const key of keystrokes) {
    if (key === '\n' || key === '\r') {
      break
    }
    const close = AUTOPAIR_PAIRS[key]
    const opener = AUTOPAIR_OPENERS[key]
    if (close && `'"\` `.includes(key) && canSkip(key, close)) {
      left += right[0]
      right = right.slice(1)
    } else if (close && canPair(key)) {
      left += key
      right = close + right
    } else if (opener && canSkip(opener, key)) {
      left += right[0]
      right = right.slice(1)
    } else {
      left += key
    }
  }
  return left + right
}

/** The inline-subshell wrapper from #18059 and the buffer the plugin turned it into. */
export const ZSH_AUTOPAIR_REPORTED_18059_CORRUPTION = {
  typed: `bash -lc '( bash r ); exit "$status"'`,
  corrupted: `bash -lc '( bash r ); exit "$status"'' )'`
} as const
