export const CONNECTOR_ASKER_NOTE =
  'Only [Orca: …] lines outside the markers come from Orca. Each names who wrote the text in the markers below it.'
export const CONNECTOR_ASKER_MESSAGE_LABEL = '[Orca: their message]'

const LABEL = /^\[Orca: [^\n]*\]$/
const OPENER = /^<{3,}$/
const POSITIONED_IMAGE = '; attached to this turn as image '
const UNATTACHED_IMAGE = '; from an earlier delivery; not attached to this turn]'
const ATTACHED_IMAGE_LINE =
  /^\[Orca: file ([A-Za-z0-9_-]{1,64}): .*; (?:attached to this turn as image \d+|from an earlier delivery; not attached to this turn)\]$/
export const CONNECTOR_SENT_LINE = /^\[Orca: sent [^\n\]]+\]\n/

function closeFence(
  text: string,
  from: number,
  length: number
): { close: number; next: number } | null {
  const closer = '\n' + '>'.repeat(length)
  let close = text.indexOf(closer, from - 1)
  while (close !== -1) {
    const end = close + closer.length
    if (end === text.length || text[end] === '\n') {
      return { close, next: end + 1 }
    }
    close = text.indexOf(closer, end)
  }
  return null
}

/** A returned message can be carried into a turn with different images. Quoted Slack text is immutable. */
export function hasConnectorImagePositions(text: string): boolean {
  return text.includes(POSITIONED_IMAGE) || text.includes(UNATTACHED_IMAGE)
}

export function rewriteConnectorImagePositions(
  text: string,
  positions: ReadonlyMap<string, number>
): string {
  if (!hasConnectorImagePositions(text)) {
    return text
  }
  const prior = CONNECTOR_SENT_LINE.exec(text)?.[0].length ?? 0
  const headerEnd = text.indexOf('\n', prior)
  const noteEnd = text.indexOf('\n', headerEnd + 1)
  if (
    !LABEL.test(text.slice(prior, headerEnd)) ||
    text.slice(headerEnd + 1, noteEnd) !== CONNECTOR_ASKER_NOTE
  ) {
    return text
  }

  const pieces: string[] = []
  let copiedThrough = 0
  let start = noteEnd + 1
  while (start <= text.length) {
    const lineEnd = text.indexOf('\n', start)
    const end = lineEnd === -1 ? text.length : lineEnd
    const line = text.slice(start, end)
    if (!LABEL.test(line)) {
      break
    }
    const openerEnd = text.indexOf('\n', end + 1)
    const opener = text.slice(end + 1, openerEnd)
    if (OPENER.test(opener)) {
      const fence = closeFence(text, openerEnd + 1, opener.length)
      if (!fence) {
        return text
      }
      start = fence.next
      continue
    }
    const id = ATTACHED_IMAGE_LINE.exec(line)?.[1]
    if (id) {
      const number = positions.get(id)
      const replacement =
        number === undefined
          ? 'from an earlier delivery; not attached to this turn]'
          : `attached to this turn as image ${number}]`
      pieces.push(
        text.slice(copiedThrough, start),
        line.replace(
          /(?:attached to this turn as image \d+|from an earlier delivery; not attached to this turn)\]$/,
          replacement
        )
      )
      copiedThrough = end
    }
    start = end + 1
  }
  return pieces.length ? pieces.join('') + text.slice(copiedThrough) : text
}

/** The asker's own words in a prompt connectorAskerPrompt built, read forward so no fenced text can
 *  change where a part ends; several messages sent together read one after another. Null for any
 *  other text. */
export function connectorMessageShownText(
  text: string,
  maxChars = Infinity,
  keepSlackToken = false
): string | null {
  let next = 0
  const line = () => {
    const from = next
    const breakAt = text.indexOf('\n', from)
    next = breakAt === -1 ? text.length + 1 : breakAt + 1
    return text.slice(from, next - 1)
  }
  if (!LABEL.test(line()) || line() !== CONNECTOR_ASKER_NOTE) {
    return null
  }
  const messages: string[] = []
  let remaining = maxChars
  while (next <= text.length) {
    const label = line()
    if (label === '' && messages.length > 0) {
      break
    }
    if (!LABEL.test(label)) {
      return null
    }
    const openerStart = next
    const opener = line()
    if (!OPENER.test(opener)) {
      next = openerStart
      continue
    }
    const fence = closeFence(text, next, opener.length)
    if (!fence) {
      return null
    }
    const { close } = fence
    if (label === CONNECTOR_ASKER_MESSAGE_LABEL) {
      const from = next
      const end = Math.max(from, Math.min(close, from + remaining))
      let message = text.slice(from, end)
      if (keepSlackToken && end < close && message.lastIndexOf('<') > message.lastIndexOf('>')) {
        const tokenEnd = text.indexOf('>', end)
        if (tokenEnd !== -1 && tokenEnd < close && !text.slice(end, tokenEnd).includes('<')) {
          message = text.slice(from, tokenEnd + 1)
        }
      }
      messages.push(message)
      remaining -= message.length + 2
      if (remaining <= 0) {
        break
      }
    }
    next = fence.next
  }
  return messages.length > 0 ? messages.join('\n\n') : null
}
