import { useCallback, useSyncExternalStore } from 'react'
import type { Editor } from '@tiptap/core'
import { documentResourceAccess } from '@/lib/files/access/local-file-access'
import { MarkdownImageCarousel } from '../../document-images/MarkdownImageCarousel'
import type { parseMarkdownImageCarousel } from '../../document-images/markdown-image-carousel'
import { useLocalImageSrc } from '../../document-images/useLocalImageSrc'
import {
  getRichMarkdownImageResolverContextVersion,
  readRichMarkdownImageStorage,
  resolveRichMarkdownImageUrl
} from './rich-markdown-image-context'

function RichMarkdownCarouselImage({
  src,
  editor,
  ...props
}: React.ImgHTMLAttributes<HTMLImageElement> & { src: string; editor: Editor }) {
  const subscribe = useCallback(
    (listener: () => void) => {
      const listeners = readRichMarkdownImageStorage(editor)?.reloadListeners
      listeners?.add(listener)
      return () => {
        listeners?.delete(listener)
      }
    },
    [editor]
  )
  useSyncExternalStore(subscribe, () => getRichMarkdownImageResolverContextVersion(editor))
  const storage = readRichMarkdownImageStorage(editor)
  const filePath = storage?.filePath ?? ''
  const resolved = useLocalImageSrc(
    filePath || !storage ? src : resolveRichMarkdownImageUrl(storage, src),
    filePath,
    undefined,
    storage?.runtimeContext,
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
  return (
    <div contentEditable={false}>
      <MarkdownImageCarousel
        images={images}
        renderImage={(image, className) => (
          <RichMarkdownCarouselImage {...image} className={className} editor={editor} />
        )}
      />
    </div>
  )
}
