import type { Element, Root, RootContent } from 'hast'
import {
  commentMarkdownAllowedTagNames,
  commentMarkdownUrlTransform
} from '../../sidebar/comment-markdown-sanitize'
import { isGitHubUserAttachmentUrl } from '../../sidebar/github-user-attachment-url'
import {
  NativeChatMarkdownImageOrigins,
  type NativeChatDocumentImageOrigin
} from './native-chat-markdown-image-origins'
import { nativeChatMarkdownImageParser } from './native-chat-markdown-image-parser'
import { prepareNativeChatMarkdown } from './native-chat-markdown-source-map'
import {
  markdownBlockContent,
  splitMarkdownTopLevelBlocks,
  type MarkdownBlock
} from '../../sidebar/markdown-top-level-blocks'
import { htmlRendersAsText } from '../../sidebar/comment-markdown-unknown-html-as-text'
import {
  NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER,
  withoutPendingNativeChatVisualDirectiveTail
} from '../../../../../shared/native-chat/native-chat-visual-directive'
import { remarkNativeChatHtmlTokenOrigins } from './native-chat-markdown-html-source-map'

export type NativeChatDocumentImage = {
  source: string
  alt: string
  linkedHref?: string
  origin: NativeChatDocumentImageOrigin
}

export function nativeChatDocumentImages(input: {
  text: string
  start?: number
  growing?: boolean
  visuals?: boolean
}): NativeChatDocumentImage[] {
  const text =
    input.visuals && input.growing
      ? withoutPendingNativeChatVisualDirectiveTail(input.text)
      : input.text
  let blocks: readonly MarkdownBlock[] = [{ text, start: 0, line: 1 }]
  if (input.growing) {
    const discovery = nativeChatMarkdownImageParser(input.visuals ?? false).use(
      remarkNativeChatHtmlTokenOrigins
    )
    blocks = splitMarkdownTopLevelBlocks(
      text,
      null,
      true,
      (source) => discovery.parse(source),
      (tail) =>
        !text.includes('\uFEFF') &&
        !(input.visuals && tail.includes(NATIVE_CHAT_VISUAL_DIRECTIVE_MARKER)),
      (html) => htmlRendersAsText(html, commentMarkdownAllowedTagNames)
    ).blocks
  }
  return blocks.flatMap((block, index) => {
    const original = markdownBlockContent(block)
    const start = (input.start ?? 0) + block.start
    const growing = Boolean(input.growing && index === blocks.length - 1 && !block.literalMath)
    const source = prepareNativeChatMarkdown(original, start, growing)
    const origins = new NativeChatMarkdownImageOrigins(source, original, start)
    const parser = nativeChatMarkdownImageParser(input.visuals ?? false, origins)
    const tree =
      block.tree && source.text === original
        ? structuredClone(block.tree)
        : parser.parse(source.text)
    const root = parser.runSync(tree)
    return nativeChatImagesFromTree(root, origins.finalNodes)
  })
}

export function nativeChatImagesFromTree(
  root: Root,
  origins: WeakMap<Element, NativeChatDocumentImageOrigin>
): NativeChatDocumentImage[] {
  const images: NativeChatDocumentImage[] = []
  function collect(node: Root | RootContent, linkedHref?: string): void {
    if (node.type === 'element' && node.tagName === 'a') {
      linkedHref =
        typeof node.properties.href === 'string'
          ? (commentMarkdownUrlTransform(node.properties.href, 'href', node) ?? undefined)
          : undefined
    }
    if (
      node.type === 'element' &&
      node.tagName === 'img' &&
      typeof node.properties.src === 'string'
    ) {
      const source = commentMarkdownUrlTransform(node.properties.src, 'src', node)
      if (
        source &&
        source !== 'streamdown:incomplete-image' &&
        !isGitHubUserAttachmentUrl(source)
      ) {
        const origin = origins.get(node)
        if (!origin) {
          throw new Error('Complete chat image lost its authored occurrence')
        }
        images.push({
          source,
          alt: typeof node.properties.alt === 'string' ? node.properties.alt : '',
          ...(linkedHref ? { linkedHref } : {}),
          origin
        })
      }
    }
    if ('children' in node) {
      for (const child of node.children) {
        collect(child, linkedHref)
      }
    }
  }
  collect(root)
  return images
}
