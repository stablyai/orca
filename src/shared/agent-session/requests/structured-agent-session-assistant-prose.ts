import type { NativeChatBlock } from '../../native-chat/native-chat-types'

// The cloud redacts webhook keys from every post, so one the blocks split must reach it whole. A key
// written raw, Markdown-escaped, percent-encoded or JSON-escaped is one run of these characters.
const KEY_CHAR = /[\w%\\-]/
const ESCAPED_KEY_CHAR = /%([0-9A-Fa-f]{2})|\\u00([0-9A-Fa-f]{2})|\\([_-])/g

const isWebhookKey = (run: string): boolean =>
  run
    .replace(ESCAPED_KEY_CHAR, (_, percent, json, markdown) =>
      typeof markdown === 'string'
        ? markdown
        : String.fromCharCode(Number.parseInt(percent ?? json, 16))
    )
    .includes('orcawh_')

const RUN_AFTER = /[\w%\\-]*/y

type KeyRun = { end: number; isKey: boolean }

/** The run of key characters the block boundary at `offset` falls inside, or null at a run's edge.
 *  A run that reached back past `from`, the previous boundary, would have held that boundary too. */
function keyRunAt(whole: string, from: number, offset: number): KeyRun | null {
  if (
    offset === 0 ||
    offset >= whole.length ||
    !KEY_CHAR.test(whole[offset - 1]!) ||
    !KEY_CHAR.test(whole[offset]!)
  ) {
    return null
  }
  let start = offset - 1
  while (start > from && KEY_CHAR.test(whole[start - 1]!)) {
    start -= 1
  }
  RUN_AFTER.lastIndex = offset
  const end = offset + RUN_AFTER.exec(whole)![0].length
  return { end, isKey: isWebhookKey(whole.slice(start, end)) }
}

/** Text blocks a line apart, except where a block boundary falls inside a webhook key. Each character
 *  is read once, however many blocks split one run. */
export function assistantProse(blocks: readonly NativeChatBlock[]): string {
  const texts = blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
  if (texts.length < 2) {
    return texts.join('')
  }
  const whole = texts.join('')
  let offset = 0
  let previous = 0
  let run: KeyRun | null = null
  return texts
    .map((text, index) => {
      // Boundaries only move forward, so a run is reused until a boundary passes its end.
      if (index > 0 && !(run && offset < run.end)) {
        run = keyRunAt(whole, previous, offset)
      }
      previous = offset
      const inKey = index > 0 && run !== null && offset < run.end && run.isKey
      offset += text.length
      return index === 0 || inKey ? text : `\n${text}`
    })
    .join('')
}
