import { useEffect, useRef, useState } from 'react'
import { Image as ImageIcon } from 'lucide-react'
import { cn } from '../../../../lib/class-names'
import { useTranslate } from '../../../../i18n/use-translate'
import { basename } from '../../../../lib/path'
import type { NativeChatBlock } from '../../../../../../shared/native-chat/native-chat-types'
import { PanZoomImageDialog } from '../../../editor/document-images/PanZoomImageDialog'
import {
  getLocalImageCacheKey,
  useLocalImageSrc
} from '../../../editor/document-images/useLocalImageSrc'
import type { RuntimeFileOperationArgs } from '../../../../runtime/files/runtime-file-client-types'
import { copyableNativeChatImageSrc, keepPreviewOpenForChatMenu } from './native-chat-image-copy'
import { isNativeChatPastedImagePath } from '../../../../../../shared/native-chat/attachments/native-chat-image-label'
import { nativeChatImageLabel } from './native-chat-image-label'
import { chatImageAccess } from '../../../../lib/files/access/local-file-access'
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
const TRANSCRIPT_IMAGE_ACCESS = chatImageAccess()

type ImageRef = Extract<NativeChatBlock, { type: 'image-ref' }>

/** One image's bytes while `active`, read from its owner (a URL loads as itself). */
function useTranscriptImageSrc(
  block: ImageRef | undefined,
  runtimeContext: RuntimeFileOperationArgs | null | undefined,
  active: boolean
): { source: string | undefined; displaySrc: string | undefined; external: boolean } {
  const source = block?.url?.trim() || block?.path
  const filePath = block?.path ?? source ?? ''
  const external = renderableImageSource(source)
  const localSrc = useLocalImageSrc(
    active && !external && runtimeContext !== undefined ? source : undefined,
    filePath,
    runtimeContext?.connectionId,
    runtimeContext,
    TRANSCRIPT_IMAGE_ACCESS
  )
  return { source, displaySrc: external && active ? source : localSrc, external }
}

function ImageLabelChip({ label }: { label: string }): React.JSX.Element {
  return (
    <div
      className="flex max-w-full items-center gap-1.5 rounded-md border border-border bg-chat-canvas px-2 py-1 text-xs text-chat-foreground-faint"
      title={label}
    >
      <ImageIcon className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </div>
  )
}

/** A thumbnail that asks to open the viewer; it reads its image only near the viewport. `className`
 *  sizes the tile (80 px squares by default) and `imageClassName` fits the image in it. */
export function NativeChatImageTile({
  block,
  runtimeContext,
  onOpen,
  className = 'size-20',
  imageClassName = 'size-full object-cover'
}: {
  block: ImageRef
  runtimeContext: RuntimeFileOperationArgs | null | undefined
  onOpen: () => void
  className?: string
  imageClassName?: string
}): React.JSX.Element {
  const t = useTranslate()
  const [near, setNear] = useState(false)
  const [thumbnailErrorSrc, setThumbnailErrorSrc] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const { source, displaySrc, external } = useTranscriptImageSrc(block, runtimeContext, near)
  const label = nativeChatImageLabel(block)
  const viewImageLabel = t('components.native-chat.composer.viewAttachment', 'View image')

  useEffect(() => {
    const element = ref.current
    if (!element) {
      return
    }
    return observeTranscriptVisibility(element, setNear)
  }, [])

  const previewable = Boolean(source) && (external || runtimeContext !== null)
  const showPreview = previewable && near && Boolean(displaySrc) && displaySrc !== thumbnailErrorSrc

  if (!previewable) {
    return (
      <div ref={ref} className="min-w-0">
        <ImageLabelChip label={label} />
      </div>
    )
  }
  // Offscreen or loading keeps the tile's box so scrolling never rewraps the row.
  if (!showPreview) {
    return (
      <div
        ref={ref}
        className={cn(
          'flex shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-border bg-chat-canvas px-1.5 text-xs text-chat-foreground-faint',
          className
        )}
        title={label}
      >
        <ImageIcon className="size-4 shrink-0" />
        <span className="max-w-full truncate">{label}</span>
      </div>
    )
  }
  return (
    <div ref={ref} className={cn('relative shrink-0', className)}>
      <button
        type="button"
        aria-label={`${viewImageLabel}: ${label}`}
        title={label}
        data-native-chat-copy-image-src={copyableNativeChatImageSrc(displaySrc)}
        onClick={onOpen}
        className="flex size-full cursor-zoom-in items-center justify-center overflow-hidden rounded-md border border-border bg-chat-canvas transition-colors hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <img
          src={displaySrc}
          alt={label}
          loading="lazy"
          onError={() => setThumbnailErrorSrc(displaySrc ?? null)}
          className={imageClassName}
        />
      </button>
    </div>
  )
}

/** The pan-and-zoom viewer over a message's images: previous and next step through them. */
export function NativeChatImageViewer({
  blocks,
  index,
  onIndexChange,
  runtimeContext
}: {
  blocks: readonly ImageRef[]
  /** The image shown; null when closed. */
  index: number | null
  onIndexChange: (index: number | null) => void
  runtimeContext: RuntimeFileOperationArgs | null | undefined
}): React.JSX.Element {
  const block = index === null ? undefined : blocks[index]
  const read = useTranscriptImageSrc(block, runtimeContext, block !== undefined)
  // The read keeps the last image's source until the next one's loads: never show it under this name.
  const [left, setLeft] = useState<{ index: number; src: string | undefined } | null>(null)
  const displaySrc =
    left?.index === index && left.src === read.displaySrc ? undefined : read.displaySrc
  const label = block ? nativeChatImageLabel(block) : ''
  const step = (by: number) => {
    if (index === null || blocks.length < 2) {
      return undefined
    }
    const to = index + by
    return to < 0 || to >= blocks.length
      ? null
      : () => {
          setLeft({ index: to, src: read.displaySrc })
          onIndexChange(to)
        }
  }
  return (
    <PanZoomImageDialog
      open={block !== undefined}
      onOpenChange={(open) => !open && onIndexChange(null)}
      src={displaySrc}
      title={label}
      showTitle
      onPrevious={step(-1)}
      onNext={step(1)}
      onInteractOutside={keepPreviewOpenForChatMenu}
      data-native-chat-copy-image-src={copyableNativeChatImageSrc(displaySrc)}
      fallback={<ImageLabelChip label={label} />}
    />
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
  const [viewing, setViewing] = useState<number | null>(null)
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
      {images.map((image, index) => {
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
          <NativeChatImageTile
            key={`${imageKeyBase}-${identity}-${occurrence}`}
            block={image}
            runtimeContext={runtimeContext}
            onOpen={() => setViewing(index)}
          />
        )
      })}
      <NativeChatImageViewer
        blocks={images}
        index={viewing}
        onIndexChange={setViewing}
        runtimeContext={runtimeContext}
      />
    </div>
  )
}
