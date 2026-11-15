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
import { deriveNativeChatRowContent } from '../../../../../shared/native-chat/transcript/row-content/native-chat-row-content'
import { commentMarkdownRemarkPlugins } from '../../sidebar/comment-markdown-remark-plugins'
import { remarkChatMath } from '../../sidebar/chat-markdown-math'
import { remarkNativeChatFileDestinations } from './native-chat-markdown-file-destinations'

function sourceReader(visuals: boolean) {
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
