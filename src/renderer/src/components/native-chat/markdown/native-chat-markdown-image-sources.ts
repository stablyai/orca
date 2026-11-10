import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { Root, RootContent } from 'mdast'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { deriveNativeChatRowContent } from '../../../../../shared/native-chat/transcript/native-chat-row-content'
import { commentMarkdownRemarkPlugins } from '../../sidebar/comment-markdown-remark-plugins'
import { remarkChatMath } from '../../sidebar/chat-markdown-math'
import { remarkNativeChatFileDestinations } from './native-chat-markdown-file-destinations'

const parser = unified()
  .use(remarkParse)
  .use(commentMarkdownRemarkPlugins)
  .use(remarkChatMath)
  .use(remarkNativeChatFileDestinations)
const sources = new WeakMap<NativeChatMessage['blocks'], readonly string[]>()

export function nativeChatMarkdownImageSources(message: NativeChatMessage): readonly string[] {
  const cached = sources.get(message.blocks)
  if (cached) {
    return cached
  }
  const root = parser.runSync(parser.parse(deriveNativeChatRowContent(message.blocks).markdown))
  const definitions = new Map<string, string>()
  const images: string[] = []
  const references: string[] = []
  function collect(node: Root | RootContent): void {
    if (node.type === 'definition' && !definitions.has(node.identifier.toUpperCase())) {
      definitions.set(node.identifier.toUpperCase(), node.url)
    }
    if (node.type === 'image') {
      images.push(node.url)
    }
    if (node.type === 'imageReference') {
      references.push(node.identifier.toUpperCase())
    }
    if ('children' in node) {
      for (const child of node.children) {
        collect(child)
      }
    }
  }
  collect(root)
  for (const reference of references) {
    const source = definitions.get(reference)
    if (source !== undefined) {
      images.push(source)
    }
  }
  sources.set(message.blocks, images)
  return images
}
