import { NativeChatImageAttachmentPreview } from '@/components/native-chat/NativeChatImageAttachmentPreview'
import type { NativeChatComposerImageAttachment } from '@/components/native-chat/NativeChatComposerField'

export function BrowserAnnotationImageStrip({
  images,
  onRemove
}: {
  images: NativeChatComposerImageAttachment[]
  onRemove: (id: string) => void
}): React.JSX.Element | null {
  if (images.length === 0) {
    return null
  }
  return (
    <div className="mt-2 flex flex-wrap gap-2 pt-1.5 pr-1.5">
      {images.map((image) => (
        <NativeChatImageAttachmentPreview key={image.id} attachment={image} onRemove={onRemove} />
      ))}
    </div>
  )
}
