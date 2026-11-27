import { useCallback, useSyncExternalStore } from 'react'
import type { Editor } from '@tiptap/core'
import { documentResourceAccess } from '@/lib/files/access/local-file-access'
import { recomputeOn } from '@/lib/recompute-on'
import { MarkdownImageCarousel } from '../../document-images/MarkdownImageCarousel'
import type { MarkdownCarouselImageContext } from '../../document-images/markdown-image-carousel-export'
import type { parseMarkdownImageCarousel } from '../../document-images/markdown-image-carousel'
import { useLocalImageSrc } from '../../document-images/useLocalImageSrc'
import {
  getRichMarkdownImageResolverContextVersion,
  readRichMarkdownImageResolverContext,
  resolveRichMarkdownImageUrl,
  subscribeRichMarkdownImageResolverContext
} from './rich-markdown-image-context'

function RichMarkdownCarouselImage({
  src,
  imageContext: { filePath, runtimeContext },
  ...props
}: React.ImgHTMLAttributes<HTMLImageElement> & { imageContext: MarkdownCarouselImageContext }) {
  const resolved = useLocalImageSrc(
    src,
    filePath,
    undefined,
    runtimeContext,
    documentResourceAccess(filePath)
  )
  return <img {...props} src={resolved} />
}

export function RichMarkdownImageCarousel({
  editor,
  images
}: {
  editor: Editor
  images: NonNullable<ReturnType<typeof parseMarkdownImageCarousel>>
}): React.JSX.Element {
  const subscribe = useCallback(
    (listener: () => void) => subscribeRichMarkdownImageResolverContext(editor, listener),
    [editor]
  )
  const version = useSyncExternalStore(subscribe, () =>
    getRichMarkdownImageResolverContextVersion(editor)
  )
  const imageContext = recomputeOn([version], () => readRichMarkdownImageResolverContext(editor))

  return (
    <div contentEditable={false}>
      <MarkdownImageCarousel
        images={images}
        imageContext={imageContext}
        renderImage={(image, className) => (
          <RichMarkdownCarouselImage
            {...image}
            src={
              imageContext.filePath
                ? image.src
                : resolveRichMarkdownImageUrl(imageContext, image.src)
            }
            className={className}
            imageContext={imageContext}
          />
        )}
      />
    </div>
  )
}
