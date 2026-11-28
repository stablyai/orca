import { documentResourceAccess } from '@/lib/files/access/local-file-access'
import type { MarkdownCarouselImage } from './markdown-image-carousel'
import {
  acquireLocalImageSrcLease,
  loadLocalImageSrc,
  type LocalImageRuntimeContext
} from './useLocalImageSrc'

export type MarkdownCarouselImageContext = {
  filePath: string
  runtimeContext?: LocalImageRuntimeContext | null
}

export const markdownImageCarouselExports = new WeakMap<
  Element,
  { images: readonly MarkdownCarouselImage[]; imageContext: MarkdownCarouselImageContext }
>()

const IMAGE_CAROUSEL_SELECTOR = '[data-orca-image-carousel]'

export async function expandMarkdownImageCarouselsForExport(
  subtree: Element,
  clone: Element,
  inlineBlobImage: (src: string) => Promise<string>
): Promise<void> {
  const carousels = Array.from(subtree.querySelectorAll(IMAGE_CAROUSEL_SELECTOR), (carousel) =>
    markdownImageCarouselExports.get(carousel)
  )
  const copies = Array.from(clone.querySelectorAll(IMAGE_CAROUSEL_SELECTOR))

  for (const [index, copy] of copies.entries()) {
    const carousel = carousels[index]
    if (!carousel) {
      continue
    }

    const content = clone.ownerDocument.createElement('template').content
    for (const image of carousel.images) {
      const src = await loadCarouselExportImage(image.src, carousel.imageContext, inlineBlobImage)
      const slide = content.ownerDocument.createElement('p')
      if (src) {
        const img = content.ownerDocument.createElement('img')
        img.src = src
        img.alt = image.alt
        if (image.title !== undefined) {
          img.title = image.title
        }
        slide.append(img)
      } else {
        slide.textContent = image.alt || image.src
      }
      content.append(slide)
    }
    copy.replaceChildren(content)
  }
}

async function loadCarouselExportImage(
  src: string,
  { filePath, runtimeContext }: MarkdownCarouselImageContext,
  inlineBlobImage: (src: string) => Promise<string>
): Promise<string | null> {
  if (runtimeContext === null) {
    return null
  }

  const args = [src, filePath, undefined, runtimeContext, documentResourceAccess(filePath)] as const
  const release = acquireLocalImageSrcLease(...args)
  try {
    const resolved = await loadLocalImageSrc(...args)
    return resolved?.startsWith('blob:') ? await inlineBlobImage(resolved) : resolved
  } finally {
    release?.()
  }
}
