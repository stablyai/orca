import type { NativeChatBlock } from './native-chat-types'

// Claude wraps a whole pasted text block; prose around it is still literal user text.
export function unwrapClaudePastedContent(text: string): string {
  const trimmed = text.trim()
  const open = /^<pasted_content(?: id="([^"<>\r\n]{1,64})")?>\r?\n/.exec(trimmed)
  if (!open) {
    return text
  }
  const close = open[1] ? `</pasted_content id="${open[1]}">` : '</pasted_content>'
  if (!trimmed.endsWith(close)) {
    return text
  }
  const body = trimmed.slice(open[0].length, -close.length)
  // Why: the id is what lets pasted text carry literal tags; only a same-id tag is ambiguous.
  const ambiguous = open[1]
    ? body.includes(close) || body.includes(`<pasted_content id="${open[1]}">`)
    : body.includes('<pasted_content') || body.includes('</pasted_content')
  if (!body.endsWith('\n') || ambiguous) {
    return text
  }
  return body.slice(0, body.endsWith('\r\n') ? -2 : -1)
}

export function unwrapClaudePastedContentBlock(block: NativeChatBlock): NativeChatBlock {
  if (block.type !== 'text') {
    return block
  }
  const text = unwrapClaudePastedContent(block.text)
  return text === block.text ? block : { ...block, text }
}
