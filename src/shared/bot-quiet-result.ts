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

/** A bot chat's settled answer hides a quiet result's marker; only a turn that said and did nothing
 *  reads "Nothing to report", and not under the automation row that opened it. */
export function quietBotAnswer(
  words: string,
  row: QuietBotAnswerRow
): { quiet: boolean; words: string; nothingToReport: boolean } {
  if (!row.botAnswer || row.streaming || !isQuietBotResult(words)) {
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
  if (!answer?.quiet) {
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
