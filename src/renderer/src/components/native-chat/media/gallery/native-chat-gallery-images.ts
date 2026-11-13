import {
  isToolCallBlock,
  type NativeChatImageRefBlock,
  type NativeChatMessage
} from '../../../../../../shared/native-chat/native-chat-types'
import { deriveNativeChatRowContent } from '../../../../../../shared/native-chat/transcript/native-chat-row-content'
import {
  nativeChatToolImageReadPath,
  nativeChatToolRunViewedImages
} from '../../../../../../shared/native-chat/tools/native-chat-tool-viewed-images'
import { isGitHubUserAttachmentUrl } from '../../../sidebar/comment-markdown-github-attachment-media'
import type { NativeChatMarkdownImage } from '../../markdown/native-chat-markdown-image-sources'

/** One image the transcript draws, in the order it draws them. */
export type NativeChatGalleryImage =
  | {
      kind: 'attachment'
      key: string
      messageId: string
      source: string
      block: NativeChatImageRefBlock
    }
  | { kind: 'markdown'; key: string; messageId: string; source: string; alt?: string }

/** The value a transcript image's own trigger knows itself by. */
export function nativeChatAttachmentImageSource(block: NativeChatImageRefBlock): string {
  return block.url?.trim() || block.path || ''
}

const MARKDOWN_ROLES = new Set<NativeChatMessage['role']>(['user', 'assistant', 'system'])

/**
 * Every image a chat draws, from transcript data rather than the DOM, so rows the virtualizer
 * has not mounted still take part. Each row draws its attachments, then its Markdown, then the
 * images its tools read.
 */
export function collectNativeChatGalleryImages(
  messages: readonly NativeChatMessage[],
  markdownImages: (message: NativeChatMessage) => readonly NativeChatMarkdownImage[]
): NativeChatGalleryImage[] {
  // Tool reads pair with results across a run's messages, so judge them over the whole chat.
  const viewedPaths = new Set(
    nativeChatToolRunViewedImages(
      messages.flatMap((message) => deriveNativeChatRowContent(message.blocks).tools)
    ).map((block) => block.path)
  )
  const placedToolPaths = new Set<string>()
  const images: NativeChatGalleryImage[] = []
  for (const message of messages) {
    const content = deriveNativeChatRowContent(message.blocks)
    let position = 0
    const key = (): string => `${message.id}\0${position++}`
    for (const block of content.prose) {
      const source = block.type === 'image-ref' ? nativeChatAttachmentImageSource(block) : ''
      if (block.type === 'image-ref' && source) {
        images.push({ kind: 'attachment', key: key(), messageId: message.id, source, block })
      }
    }
    if (MARKDOWN_ROLES.has(message.role) && content.hasText) {
      for (const { source, alt } of markdownImages(message)) {
        // GitHub attachments draw through their own authenticated viewer.
        if (!isGitHubUserAttachmentUrl(source)) {
          images.push({ kind: 'markdown', key: key(), messageId: message.id, source, alt })
        }
      }
    }
    for (const block of content.tools) {
      const path = isToolCallBlock(block) ? nativeChatToolImageReadPath(block) : null
      if (path && viewedPaths.has(path) && !placedToolPaths.has(path)) {
        placedToolPaths.add(path)
        const imageBlock: NativeChatImageRefBlock = { type: 'image-ref', path }
        images.push({
          kind: 'attachment',
          key: key(),
          messageId: message.id,
          source: path,
          block: imageBlock
        })
      }
    }
  }
  return images
}

/** The opened image: the same source in the same row when the trigger knows its row, else the first. */
export function findNativeChatGalleryImage(
  images: readonly NativeChatGalleryImage[],
  source: string,
  messageId?: string
): NativeChatGalleryImage | undefined {
  const matches = images.filter((image) => image.source === source)
  return matches.find((image) => image.messageId === messageId) ?? matches[0]
}
