// A comment's files: chat-attachment store paths of any kind its text names as `@path`. The card shows
// them as file buttons and the words without them; the agent's mail keeps them as written.
import {
  isChatAttachmentStorePath,
  nativeChatTextAttachmentParts
} from '../native-chat/attachments/native-chat-text-attachment-references'

export function botItemCommentFiles(text: string): { words: string; files: string[] } {
  const parts = nativeChatTextAttachmentParts(text, true, isChatAttachmentStorePath)
  const files = [...new Set(parts.flatMap((part) => (part.path ? [part.path] : [])))]
  if (files.length === 0) {
    return { words: text, files }
  }
  const words = parts
    .flatMap((part) => (part.path ? [] : [part.text]))
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { words, files }
}
