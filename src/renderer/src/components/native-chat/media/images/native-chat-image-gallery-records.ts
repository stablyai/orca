import type {
  NativeChatMessage,
  NativeChatImageRefBlock
} from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatTurnRows } from '../../conversation/slots/use-native-chat-turn-membership'
import { deriveNativeChatRowContent } from '../../../../../../shared/native-chat/transcript/native-chat-row-content'
import {
  nativeChatMarkdownImageSources,
  nativeChatVisualMarkdownImageSources
} from '../../markdown/native-chat-markdown-image-sources'
import { nativeChatImageLabel } from './native-chat-image-label'
import { basename } from '@/lib/path'
export type NativeChatGalleryRecord = {
  id: string
  rowId: string
  source: string
  title: string
  kind: 'markdown' | 'reference'
  block?: NativeChatImageRefBlock
}
export function nativeChatGalleryGroup(rows: NativeChatTurnRows, index: number): string {
  const message = rows.messages[index]
  return message.role === 'user'
    ? `user:${message.id}`
    : (rows.turnKeys[index] ?? message.turnId ?? message.id)
}
function rowImages(message: NativeChatMessage, visuals: boolean): NativeChatGalleryRecord[] {
  const refs = deriveNativeChatRowContent(message.blocks).prose.filter(
    (block) => block.type === 'image-ref'
  )
  const images: NativeChatGalleryRecord[] = refs.flatMap((block, index) => {
    const source = block.url?.trim() || block.path
    return source
      ? [
          {
            id: `reference:${message.id}:${index}`,
            rowId: message.id,
            source,
            title: nativeChatImageLabel(block),
            kind: 'reference',
            block
          }
        ]
      : []
  })
  const hasMarkdownImages = message.blocks.some(
    (block) => block.type === 'text' && /!\[|<img\b|\[[^\]]+\]:/i.test(block.text)
  )
  if (hasMarkdownImages) {
    const read = visuals ? nativeChatVisualMarkdownImageSources : nativeChatMarkdownImageSources
    images.push(
      ...read(message).map((source, index): NativeChatGalleryRecord => ({
        id: `markdown:${message.id}:${index}`,
        rowId: message.id,
        source,
        title: /^(?:https?|data|blob):/i.test(source)
          ? `Image ${index + 1}`
          : basename(source).slice(0, 512),
        kind: 'markdown'
      }))
    )
  }
  return images
}
export function nativeChatGalleryRecords(
  rows: NativeChatTurnRows,
  group: string,
  visuals: boolean
): NativeChatGalleryRecord[] {
  return rows.messages.flatMap((message, index) =>
    nativeChatGalleryGroup(rows, index) === group ? rowImages(message, visuals) : []
  )
}
