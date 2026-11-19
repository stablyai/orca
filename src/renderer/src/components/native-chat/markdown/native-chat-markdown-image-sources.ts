import type { Root, RootContent } from 'hast'
import { commentMarkdownUrlTransform } from '../../comment-markdown/comment-markdown-sanitize'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { deriveNativeChatRowContent } from '../../../../../shared/native-chat/transcript/row-content/native-chat-row-content'
import { nativeChatMarkdownImageParser } from './native-chat-markdown-image-parser'

function sourceReader(visuals: boolean) {
  const parser = nativeChatMarkdownImageParser(visuals)
  const sources = new WeakMap<NativeChatMessage['blocks'], readonly string[]>()

  return function imageSources(message: NativeChatMessage): readonly string[] {
    const cached = sources.get(message.blocks)
    if (cached) {
      return cached
    }
    const root = parser.runSync(parser.parse(deriveNativeChatRowContent(message.blocks).markdown))
    const images: string[] = []
    function collect(node: Root | RootContent): void {
      if (
        node.type === 'element' &&
        node.tagName === 'img' &&
        typeof node.properties.src === 'string'
      ) {
        const source = commentMarkdownUrlTransform(node.properties.src, 'src', node)
        if (source) {
          images.push(source)
        }
      }
      if ('children' in node) {
        for (const child of node.children) {
          collect(child)
        }
      }
    }
    collect(root)
    sources.set(message.blocks, images)
    return images
  }
}

export const nativeChatMarkdownImageSources = sourceReader(false)
export const nativeChatVisualMarkdownImageSources = sourceReader(true)
