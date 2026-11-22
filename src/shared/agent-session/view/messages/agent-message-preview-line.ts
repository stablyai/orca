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
      // A bare web address is a link only in the open message, so the row must open to reach it.
      const bareAddress = /(?:https?:\/\/|www\.)\S/.test(plain)
      return { line: cut, more: cut !== whole || bareAddress }
    }
  }
  return { line: '', more: whole.length > 0 }
}

function plainMarkdownLine(line: string): string {
  return (
    line
      .replace(/^(?:#{1,6}|>+|[-*+]|\d+[.)])\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '')
      // Images and links keep their words; their addresses (which may hold parentheses) stay in
      // the open message.
      .replace(/!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
      // Only marks paired around words, so globs such as src/**/*.ts and *.ts,*.js keep their stars.
      .replace(/(\*\*|__|~~)(?=[^\s*/])(.+?)(?<=[^\s*/])\1/g, '$2')
      .replace(/`([^`]+)`/g, '$1')
      // Single emphasis, as in *Done*, but not a lone star such as 5 * 3.
      .replace(/(^|[^\w*])\*(?=[\p{L}\p{N}])([^*]*?[\p{L}\p{N}])\*(?![\w*])/gu, '$1$2')
      // Single underscore emphasis, as in _Done_, but not the underscores inside names such as term_0.
      .replace(
        /(^|[^\p{L}\p{N}_])_(?=[\p{L}\p{N}])([^_]*?[\p{L}\p{N}])_(?![\p{L}\p{N}_])/gu,
        '$1$2'
      )
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
