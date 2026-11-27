import { Lexer } from 'marked'
import { isWindowsAbsolutePathLike } from '../../../../../shared/file-access/cross-platform-path'
import { markdownPreviewUrlTransform } from '../markdown-preview/links/markdown-preview-url-transform'

export type MarkdownCarouselImage = { src: string; alt: string; title?: string }

export function parseMarkdownImageCarousel(
  source: string
): [MarkdownCarouselImage, ...MarkdownCarouselImage[]] | null {
  const images: MarkdownCarouselImage[] = []
  for (const slide of source.split(/^[ \t]*<!-- slide -->[ \t]*\r?$/m)) {
    const [token, extra] = Lexer.lexInline(slide.trim())
    if (
      extra ||
      token?.type !== 'image' ||
      typeof token.href !== 'string' ||
      typeof token.text !== 'string'
    ) {
      return null
    }
    const src = isWindowsAbsolutePathLike(token.href)
      ? token.href
      : markdownPreviewUrlTransform(token.href, 'src')
    if (!src) {
      return null
    }
    images.push({
      src,
      alt: token.text,
      title: typeof token.title === 'string' ? token.title : undefined
    })
  }
  const [first, ...rest] = images
  return first ? [first, ...rest] : null
}
