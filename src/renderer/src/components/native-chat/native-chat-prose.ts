import { isTextBlock, type NativeChatBlock } from '../../../../shared/native-chat-types'

export function nativeChatProseToMarkdown(blocks: NativeChatBlock[]): string {
  return blocks
    .map((block) => (isTextBlock(block) ? block.text : ''))
    .filter((part) => part.length > 0)
    .join('\n\n')
}
