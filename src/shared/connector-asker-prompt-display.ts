export const CONNECTOR_ASKER_NOTE =
  'Only [Orca: …] lines outside the markers come from Orca. Each names who wrote the text in the markers below it.'
export const CONNECTOR_ASKER_MESSAGE_LABEL = '[Orca: their message]'

const LABEL = /^\[Orca: [^\n]*\]$/
const OPENER = /^<{3,}$/

/** The asker's own words in a prompt connectorAskerPrompt built, read forward so no fenced text can
 *  change where a part ends; several messages sent together read one after another. Null for any
 *  other text. */
export function connectorMessageShownText(text: string, maxChars = Infinity): string | null {
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
    const closeLine = '\n' + '>'.repeat(opener.length)
    let close = text.indexOf(closeLine, next - 1)
    while (close !== -1) {
      const end = close + closeLine.length
      if (end === text.length || text[end] === '\n') {
        break
      }
      close = text.indexOf(closeLine, end)
    }
    if (close === -1) {
      return null
    }
    if (label === CONNECTOR_ASKER_MESSAGE_LABEL) {
      const from = next
      const message = text.slice(from, Math.max(from, Math.min(close, from + remaining)))
      messages.push(message)
      remaining -= message.length + 2
      if (remaining <= 0) {
        break
      }
    }
    next = close + closeLine.length + 1
  }
  return messages.length > 0 ? messages.join('\n\n') : null
}
