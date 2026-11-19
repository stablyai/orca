import { isTextBlock, type NativeChatBlock } from './native-chat/native-chat-types'

/** A bot's final message ending with this has nothing worth reporting, so nobody is told. */
export const BOT_QUIET_MARKER = 'NO_REPLY'

// The marker as the message's last word, however the model dressed it: `NO_REPLY`, **NO_REPLY**,
// NO_REPLY., **NO_REPLY.** A word that only contains it (XNO_REPLY) doesn't count.
const QUIET_ENDING = new RegExp(`(?:^|\\s)[\`*_]*${BOT_QUIET_MARKER}[\`*_.!]*\\s*$`)

export function isQuietBotResult(message: string): boolean {
  return QUIET_ENDING.test(message)
}

/** What a quiet message said before its marker; empty when it was only the marker. */
export function quietBotResultText(message: string): string {
  return message.replace(QUIET_ENDING, '').trimEnd()
}

export type QuietBotAnswerRow = {
  /** An assistant row in a bot's chat. */
  botAnswer: boolean
  /** Still streaming, so the marker may yet be followed by more. */
  streaming: boolean
  /** An automation's row opened the turn, which already says what ran. */
  inAutomationTurn: boolean
  /** The turn changed an item, posted or otherwise did something others see. */
  inActingTurn: boolean
}

const MARKER_DRESSING = /^[`*_]*/
const MARKER_TRAILING_DRESSING = /^[`*_.!]*$/

/** Words without a last word that is, or may still grow into, the marker: `NO_R`, **NO_REPLY*. */
function withoutGrowingMarker(words: string): string {
  const trimmed = words.trimEnd()
  const wordStart =
    Math.max(trimmed.lastIndexOf(' '), trimmed.lastIndexOf('\n'), trimmed.lastIndexOf('\t')) + 1
  const word = trimmed.slice(wordStart)
  const bare = word.replace(MARKER_DRESSING, '')
  const growing =
    bare.length > 0 &&
    (BOT_QUIET_MARKER.startsWith(bare) ||
      (bare.startsWith(BOT_QUIET_MARKER) &&
        MARKER_TRAILING_DRESSING.test(bare.slice(BOT_QUIET_MARKER.length))))
  return growing ? trimmed.slice(0, wordStart).trimEnd() : words
}

/** A bot chat's answer never draws its marker; only a settled turn that said and did nothing reads
 *  "Nothing to report", and not under the automation row that opened it. */
export function quietBotAnswer(
  words: string,
  row: QuietBotAnswerRow
): { quiet: boolean; words: string; nothingToReport: boolean } {
  if (!row.botAnswer) {
    return { quiet: false, words, nothingToReport: false }
  }
  // Still streaming, the marker may be arriving or followed by more: hold back what could be it.
  if (row.streaming) {
    return {
      quiet: false,
      words: withoutGrowingMarker(words),
      nothingToReport: false
    }
  }
  if (!isQuietBotResult(words)) {
    return { quiet: false, words, nothingToReport: false }
  }
  const text = quietBotResultText(words)
  return {
    quiet: true,
    words: text,
    nothingToReport: !text && !row.inAutomationTurn && !row.inActingTurn
  }
}

/** `quietBotAnswer` for a row drawn block by block: the marker ends its last text block. */
export function quietBotAnswerBlocks(
  blocks: NativeChatBlock[],
  row: QuietBotAnswerRow
): { blocks: NativeChatBlock[]; nothingToReport: boolean } {
  const last = blocks.findLastIndex(isTextBlock)
  const block = blocks[last]
  const answer = block && isTextBlock(block) ? quietBotAnswer(block.text, row) : null
  if (!answer || !isTextBlock(block) || answer.words === block.text) {
    return { blocks, nothingToReport: false }
  }
  const text = answer.words
  const shown = blocks.flatMap((each, index) =>
    index !== last ? [each] : text && isTextBlock(each) ? [{ ...each, text }] : []
  )
  return {
    blocks: shown,
    nothingToReport:
      answer.nothingToReport && !shown.some((each) => isTextBlock(each) && each.text.trim())
  }
}
