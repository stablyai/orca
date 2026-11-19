import { isTextBlock, type NativeChatBlock } from '../../native-chat-types'

export function nativeChatProseToMarkdown(blocks: NativeChatBlock[], maxLength = Infinity): string {
  const only = blocks[0]
  if (blocks.length === 1 && only?.type === 'text' && maxLength >= only.text.length) {
    return only.text
  }
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
    const part = block.text.slice(0, maxLength - length)
    parts.push(part)
    length += part.length
  }
  return parts.join('')
}
