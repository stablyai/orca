import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { isWindowsAbsolutePathLike } from '../../../../../shared/file-access/cross-platform-path'
import { markdownPreviewUrlTransform } from '../markdown-preview/links/markdown-preview-url-transform'

export type MarkdownCarouselImage = { src: string; alt: string; title?: string }

const parser = unified().use(remarkParse)

export function parseMarkdownImageCarousel(
  source: string
): [MarkdownCarouselImage, ...MarkdownCarouselImage[]] | null {
  const images: MarkdownCarouselImage[] = []
  for (const slide of source.split(/^[ \t]*<!-- slide -->[ \t]*\r?$/m)) {
    const [paragraph, extraBlock] = parser.parse(slide.trim()).children
    if (extraBlock || paragraph?.type !== 'paragraph') {
      return null
    }
    const [image, extraInline] = paragraph.children
    if (extraInline || image?.type !== 'image') {
      return null
    }
    const src = isWindowsAbsolutePathLike(image.url)
      ? image.url
      : markdownPreviewUrlTransform(image.url, 'src')
    if (!src) {
      return null
    }
    images.push({ src, alt: image.alt ?? '', title: image.title ?? undefined })
  }
  const [first, ...rest] = images
  return first ? [first, ...rest] : null
}
