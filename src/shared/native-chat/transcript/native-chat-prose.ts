import { isTextBlock, type NativeChatBlock } from '../native-chat-types'
import { codexAsyncQuestionReplyMarkdown } from '../../codex-async-question-input'

export function nativeChatProseToMarkdown(blocks: NativeChatBlock[], maxLength = Infinity): string {
  const parts: string[] = []
  let length = 0
  for (const block of blocks) {
    if (length >= maxLength) {
      break
    }
    if (!isTextBlock(block) || block.text.length === 0) {
      continue
    }
    if (parts.length > 0) {
      const separator = '\n\n'.slice(0, maxLength - length)
      parts.push(separator)
      length += separator.length
    }
    const part = codexAsyncQuestionReplyMarkdown(block.text).slice(0, maxLength - length)
    parts.push(part)
    length += part.length
  }
  return parts.join('')
}
