import { nativeChatVisualRemarkPlugins } from '../media/visuals/native-chat-visual-markdown-syntax'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import type { Root, RootContent } from 'hast'
import {
  commentMarkdownSanitizeSchema,
  commentMarkdownAllowedTagNames,
  commentMarkdownUrlTransform
} from '../../sidebar/comment-markdown-sanitize'
import { remarkUnknownHtmlAsText } from '../../sidebar/comment-markdown-unknown-html-as-text'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { deriveNativeChatRowContent } from '../../../../../shared/native-chat/transcript/native-chat-row-content'
import { commentMarkdownRemarkPlugins } from '../../sidebar/comment-markdown-remark-plugins'
import { remarkChatMath } from '../../sidebar/chat-markdown-math'
import { remarkNativeChatFileDestinations } from './native-chat-markdown-file-destinations'

/** A Markdown image as the chat renders it: its sanitized source and alt text. */
export type NativeChatMarkdownImage = { source: string; alt?: string }

function imageReader(visuals: boolean) {
  const parser = unified()
    .use(remarkParse)
    .use(remarkUnknownHtmlAsText(commentMarkdownAllowedTagNames))
    .use(commentMarkdownRemarkPlugins)
    .use(remarkChatMath)
    .use(visuals ? nativeChatVisualRemarkPlugins('image-source-discovery') : [])
    .use(remarkNativeChatFileDestinations)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, commentMarkdownSanitizeSchema)
  const read = new WeakMap<NativeChatMessage['blocks'], readonly NativeChatMarkdownImage[]>()

  return function images(message: NativeChatMessage): readonly NativeChatMarkdownImage[] {
    const cached = read.get(message.blocks)
    if (cached) {
      return cached
    }
    const root = parser.runSync(parser.parse(deriveNativeChatRowContent(message.blocks).markdown))
    const images: NativeChatMarkdownImage[] = []
    function collect(node: Root | RootContent): void {
      if (
        node.type === 'element' &&
        node.tagName === 'img' &&
        typeof node.properties.src === 'string'
      ) {
        const source = commentMarkdownUrlTransform(node.properties.src, 'src', node)
        if (source) {
          const alt = node.properties.alt
          images.push(typeof alt === 'string' ? { source, alt } : { source })
        }
      }
      if ('children' in node) {
        for (const child of node.children) {
          collect(child)
        }
      }
    }
    collect(root)
    read.set(message.blocks, images)
    return images
  }
}

function sourceReader(
  images: (message: NativeChatMessage) => readonly NativeChatMarkdownImage[]
): (message: NativeChatMessage) => readonly string[] {
  const sources = new WeakMap<readonly NativeChatMarkdownImage[], readonly string[]>()
  return (message) => {
    const found = images(message)
    const cached = sources.get(found)
    if (cached) {
      return cached
    }
    const list = found.map((image) => image.source)
    sources.set(found, list)
    return list
  }
}

export const nativeChatMarkdownImages = imageReader(false)
export const nativeChatVisualMarkdownImages = imageReader(true)
export const nativeChatMarkdownImageSources = sourceReader(nativeChatMarkdownImages)
export const nativeChatVisualMarkdownImageSources = sourceReader(nativeChatVisualMarkdownImages)
