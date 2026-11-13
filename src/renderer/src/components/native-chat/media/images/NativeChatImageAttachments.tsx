import { useNativeChatImageGallery } from './native-chat-image-gallery-context'
import { useNativeChatReferenceImageSource } from './use-native-chat-reference-image-source'
import { useEffect, useRef, useState } from 'react'
import { Image as ImageIcon } from 'lucide-react'
import { cn } from '../../../../lib/class-names'
import { useTranslate } from '../../../../i18n/use-translate'
import { basename } from '../../../../lib/path'
import type { NativeChatBlock } from '../../../../../../shared/native-chat/native-chat-types'
import { PanZoomImageDialog } from '../../../editor/PanZoomImageDialog'
import { getLocalImageCacheKey } from '../../../editor/document-images/useLocalImageSrc'
import type { RuntimeFileOperationArgs } from '../../../../runtime/files/runtime-file-client-types'
import { copyableNativeChatImageSrc, keepPreviewOpenForChatMenu } from './native-chat-image-copy'
import { isNativeChatPastedImagePath } from '../../../../../../shared/native-chat/native-chat-image-label'
import { nativeChatImageLabel } from './native-chat-image-label'
import { observeTranscriptVisibility } from './native-chat-image-visibility'

function renderableImageSource(source: string | undefined): boolean {
  return Boolean(source && /^(?:https?|data|blob):/i.test(source))
}

function transcriptImageIdentity(
  block: Extract<NativeChatBlock, { type: 'image-ref' }>,
  runtimeContext: RuntimeFileOperationArgs | null | undefined
): string {
  const source = block.url?.trim() || block.path
  const filePath = block.path ?? source ?? ''
  if (renderableImageSource(source)) {
    return `external\0${source ?? ''}`
  }
  return `${source ?? ''}\0${filePath}\0${
    runtimeContext === null
      ? 'unresolved'
      : runtimeContext === undefined
        ? 'pending'
        : getLocalImageCacheKey(source ?? '', runtimeContext.connectionId, runtimeContext)
  }`
}

// Roles do not prove who chose an auto-loaded path; main must validate local images by real file type.

function TranscriptImagePreview({
  block,
  runtimeContext
}: {
  block: Extract<NativeChatBlock, { type: 'image-ref' }>
  runtimeContext: RuntimeFileOperationArgs | null | undefined
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [near, setNear] = useState(false)
  const [thumbnailErrorSrc, setThumbnailErrorSrc] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const source = block.url?.trim() || block.path
  const external = renderableImageSource(source)
  const leaseActive = near || open
  const displaySrc = useNativeChatReferenceImageSource(block, runtimeContext, leaseActive)
  const copySrc = copyableNativeChatImageSrc(displaySrc)
  const label = nativeChatImageLabel(block)
  const openGallery = useNativeChatImageGallery(source, label, displaySrc)
  const viewImageLabel = t('components.native-chat.composer.viewAttachment', 'View image')
  const fallback = (
    <div
      className="flex max-w-full items-center gap-1.5 rounded-md border border-border bg-chat-canvas px-2 py-1 text-xs text-chat-foreground-faint"
      title={label}
    >
      <ImageIcon className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </div>
  )

  useEffect(() => {
    const element = ref.current
    if (!element) {
      return
    }
    return observeTranscriptVisibility(element, setNear)
  }, [])

  const previewable = Boolean(source) && (external || runtimeContext !== null)
  const showPreview =
    previewable && leaseActive && Boolean(displaySrc) && displaySrc !== thumbnailErrorSrc

  if (!previewable) {
    return <div ref={ref}>{fallback}</div>
  }
  // Offscreen or loading keeps the thumbnail's square so scrolling never rewraps the row.
  if (!showPreview) {
    return (
      <div
        ref={ref}
        className="flex size-20 shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-border bg-chat-canvas px-1.5 text-xs text-chat-foreground-faint"
        title={label}
      >
        <ImageIcon className="size-4 shrink-0" />
        <span className="max-w-full truncate">{label}</span>
      </div>
    )
  }
  return (
    <div ref={ref} className="relative size-20 shrink-0">
      <button
        type="button"
        aria-label={`${viewImageLabel}: ${label}`}
        title={label}
        data-native-chat-copy-image-src={copySrc}
        onClick={() => (openGallery ? openGallery() : setOpen(true))}
        className="flex size-full items-center justify-center overflow-hidden rounded-md border border-border bg-chat-canvas transition-colors hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <img
          src={displaySrc}
          alt={label}
          loading="lazy"
          onError={() => setThumbnailErrorSrc(displaySrc ?? null)}
          className="size-full object-cover"
        />
      </button>
      <PanZoomImageDialog
        open={open}
        onOpenChange={setOpen}
        src={displaySrc}
        title={label}
        showTitle
        onInteractOutside={keepPreviewOpenForChatMenu}
        data-native-chat-copy-image-src={copySrc}
        fallback={fallback}
      />
    </div>
  )
}

export function NativeChatImageAttachments({
  blocks,
  runtimeContext,
  enablePreview = runtimeContext !== undefined,
  className
}: {
  blocks: NativeChatBlock[]
  runtimeContext?: RuntimeFileOperationArgs | null
  /** Callers without an image owner get label-only chips. */
  enablePreview?: boolean
  className?: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const images = blocks.filter((block) => block.type === 'image-ref')
  if (images.length === 0) {
    return null
  }
  const imageKeyCounts = new Map<string, number>()
  if (!enablePreview) {
    return (
      <div className={cn('mb-2 flex flex-wrap gap-1.5', className)}>
        {images.map((image) => {
          const label =
            image.alt ??
            image.path ??
            image.url ??
            t('components.native-chat.transcript.imageFallback', 'Image')
          const imageKeyBase = `${label}-${image.url ?? ''}-${image.path ?? ''}`
          const occurrence = imageKeyCounts.get(imageKeyBase) ?? 0
          imageKeyCounts.set(imageKeyBase, occurrence + 1)
          const name =
            image.path && isNativeChatPastedImagePath(image.path)
              ? t('components.native-chat.composer.pastedImageLabel', 'Pasted image')
              : image.path
                ? basename(image.path)
                : label
          return (
            <div
              key={`${imageKeyBase}-${occurrence}`}
              className="flex max-w-full items-center gap-1.5 rounded-md border border-border bg-chat-canvas px-2 py-1 text-xs text-chat-foreground-faint"
              title={label}
            >
              <ImageIcon className="size-3.5 shrink-0" />
              <span className="truncate">{name}</span>
            </div>
          )
        })}
      </div>
    )
  }
  return (
    <div className={cn('mb-2 flex flex-wrap gap-1.5', className)}>
      {images.map((image) => {
        const label =
          image.alt ??
          image.path ??
          image.url ??
          t('components.native-chat.transcript.imageFallback', 'Image')
        const imageKeyBase = `${label}-${image.url ?? ''}-${image.path ?? ''}`
        const occurrence = imageKeyCounts.get(imageKeyBase) ?? 0
        imageKeyCounts.set(imageKeyBase, occurrence + 1)
        const identity = transcriptImageIdentity(image, runtimeContext)
        return (
          <TranscriptImagePreview
            key={`${imageKeyBase}-${identity}-${occurrence}`}
            block={image}
            runtimeContext={runtimeContext}
          />
        )
      })}
    </div>
  )
}
