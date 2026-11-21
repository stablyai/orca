/** Longer lines are cut: the row truncates far sooner, and the whole line is its button's name. */
const PREVIEW_MAX_CHARS = 200

export type AgentMessagePreviewLine = {
  /** The first line with words, as plain text; empty when the message has none outside code. */
  line: string
  /** Whether the message holds anything the line leaves out: more lines, markup, a link's address. */
  more: boolean
}

/** A message between agents as its folded row shows it: the first line with words, Markdown marks
 *  dropped, on one line. */
export function agentMessagePreviewLine(text: string): AgentMessagePreviewLine {
  const whole = text.trim()
  let fenced = false
  for (const raw of whole.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('```') || line.startsWith('~~~')) {
      fenced = !fenced
      continue
    }
    if (fenced) {
      continue
    }
    const plain = plainMarkdownLine(line)
    if (/[\p{L}\p{N}]/u.test(plain)) {
      const cut = cutAtCodePoint(plain, PREVIEW_MAX_CHARS)
      return { line: cut, more: cut !== whole }
    }
  }
  return { line: '', more: whole.length > 0 }
}

function plainMarkdownLine(line: string): string {
  return (
    line
      .replace(/^(?:#{1,6}|>+|[-*+]|\d+[.)])\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '')
      // Images and links keep their words; their addresses stay in the open message.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*|__|~~|`/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

/** Cuts on a code-point boundary so a clipped emoji never leaves a lone surrogate. */
function cutAtCodePoint(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text
  }
  const last = text.charCodeAt(maxChars - 1)
  const end = last >= 0xd800 && last <= 0xdbff ? maxChars - 1 : maxChars
  return `${text.slice(0, end).trimEnd()}…`
}
