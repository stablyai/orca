import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Image as ImageIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { basename } from '@/lib/path'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import { NativeChatCopyButton } from './NativeChatCopyButton'
import { nativeChatProviderFrameSummary } from '../../../../shared/native-chat-provider-frame-summary'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  getLocalImageCacheKey,
  useLocalImageSrc,
  releaseLocalImageSrc
} from '@/components/editor/useLocalImageSrc'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import { isNativeChatPastedImagePath } from './native-chat-image-paste'

type VisibilityListener = (isVisible: boolean) => void

const visibilityListeners = new Map<Element, VisibilityListener>()
let visibilityObserver: IntersectionObserver | null = null

function observeTranscriptVisibility(element: Element, listener: VisibilityListener): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    listener(true)
    return () => {}
  }

  visibilityObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        visibilityListeners.get(entry.target)?.(entry.isIntersecting)
      }
    },
    { rootMargin: '128px' }
  )
  visibilityListeners.set(element, listener)
  visibilityObserver.observe(element)

  return () => {
    visibilityListeners.delete(element)
    visibilityObserver?.unobserve(element)
    if (visibilityListeners.size === 0) {
      visibilityObserver?.disconnect()
      visibilityObserver = null
    }
  }
}

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

function TranscriptImagePreview({
  block,
  runtimeContext
}: {
  block: Extract<NativeChatBlock, { type: 'image-ref' }>
  runtimeContext: RuntimeFileOperationArgs | null | undefined
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [near, setNear] = useState(false)
  const [thumbnailErrorSrc, setThumbnailErrorSrc] = useState<string | null>(null)
  const [dialogErrorSrc, setDialogErrorSrc] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const source = block.url?.trim() || block.path
  const filePath = block.path ?? source ?? ''
  const external = renderableImageSource(source)
  const leaseActive = near || open
  const localSrc = useLocalImageSrc(
    leaseActive && !external && runtimeContext !== undefined ? source : undefined,
    filePath,
    runtimeContext?.connectionId,
    runtimeContext
  )
  const displaySrc = external && leaseActive ? source : localSrc
  const label =
    block.alt?.trim() ||
    (block.path && isNativeChatPastedImagePath(block.path)
      ? translate('components.native-chat.composer.pastedImageLabel', 'Pasted image')
      : block.path
        ? basename(block.path)
        : 'Image')
  const viewImageLabel = translate('components.native-chat.composer.viewAttachment', 'View image')
  const fallback = (
    <div
      className="flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground"
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
  useEffect(() => {
    const context = runtimeContext
    if (!source || external || context === undefined || context === null) {
      return
    }
    if (!leaseActive) {
      releaseLocalImageSrc(source, filePath, context.connectionId, context)
    }
    return () => releaseLocalImageSrc(source, filePath, context.connectionId, context)
  }, [external, filePath, leaseActive, runtimeContext, source])

  const showPreview =
    leaseActive &&
    Boolean(displaySrc) &&
    displaySrc !== thumbnailErrorSrc &&
    Boolean(source) &&
    (external || runtimeContext !== null)

  if (!showPreview) {
    return <div ref={ref}>{fallback}</div>
  }
  return (
    <div ref={ref} className="relative size-20 shrink-0">
      <button
        type="button"
        aria-label={`${viewImageLabel}: ${label}`}
        title={label}
        onClick={() => setOpen(true)}
        className="flex size-full items-center justify-center overflow-hidden rounded-md border border-border bg-background transition-colors hover:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <img
          src={displaySrc}
          alt={label}
          loading="lazy"
          onError={() => setThumbnailErrorSrc(displaySrc ?? null)}
          className="size-full object-cover"
        />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[90vh] max-w-[90vw] flex-col gap-3 border-border bg-background p-3 sm:max-w-4xl">
          <DialogTitle className="truncate text-sm">{label}</DialogTitle>
          <DialogDescription className="sr-only">
            {translate('components.native-chat.composer.imagePreview', 'Full-size image preview')}
          </DialogDescription>
          <div className="scrollbar-sleek flex min-h-0 items-center justify-center overflow-auto rounded-md bg-muted/20 p-2">
            {displaySrc && displaySrc !== dialogErrorSrc ? (
              <img
                src={displaySrc}
                alt={label}
                onError={() => setDialogErrorSrc(displaySrc)}
                className="max-h-[75vh] max-w-full object-contain"
              />
            ) : (
              fallback
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function NativeChatImageAttachments({
  blocks,
  runtimeContext,
  enablePreview = runtimeContext !== undefined
}: {
  blocks: NativeChatBlock[]
  runtimeContext?: RuntimeFileOperationArgs | null
  /** Keep legacy terminal chips unchanged until that lane opts into previews. */
  enablePreview?: boolean
}): React.JSX.Element | null {
  const images = blocks.filter((block) => block.type === 'image-ref')
  if (images.length === 0) {
    return null
  }
  const imageKeyCounts = new Map<string, number>()
  if (!enablePreview) {
    return (
      <div className="mb-2 flex flex-wrap gap-1.5">
        {images.map((image) => {
          const label = image.alt ?? image.path ?? image.url ?? 'Image'
          const imageKeyBase = `${label}-${image.url ?? ''}-${image.path ?? ''}`
          const occurrence = imageKeyCounts.get(imageKeyBase) ?? 0
          imageKeyCounts.set(imageKeyBase, occurrence + 1)
          const name =
            image.path && isNativeChatPastedImagePath(image.path)
              ? translate('components.native-chat.composer.pastedImageLabel', 'Pasted image')
              : image.path
                ? basename(image.path)
                : label
          return (
            <div
              key={`${imageKeyBase}-${occurrence}`}
              className="flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground"
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
    <div className="mb-2 flex flex-wrap gap-1.5">
      {images.map((image) => {
        const label = image.alt ?? image.path ?? image.url ?? 'Image'
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

export function NativeChatAgentControls({
  markdown,
  onScrollToTop,
  className
}: {
  markdown: string
  onScrollToTop: () => void
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <NativeChatCopyButton text={markdown} />
      <button
        type="button"
        onClick={onScrollToTop}
        aria-label={translate(
          'components.native-chat.scrollMessageToTop',
          'Scroll this message to top'
        )}
        title={translate('components.native-chat.scrollMessageToTop', 'Scroll this message to top')}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowUp className="size-3.5" />
      </button>
    </div>
  )
}

export function ProviderFrameRow({ block }: { block: NativeChatBlock }): React.JSX.Element | null {
  if (block.type !== 'text' || !block.providerFrame) {
    return null
  }
  const frame = block.providerFrame
  return (
    <details className="group text-xs text-muted-foreground">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 font-mono hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="transition-transform group-open:rotate-90">›</span>
        <span className="font-medium text-foreground">{frame.provider}</span>
        <span className="truncate">{nativeChatProviderFrameSummary(block)}</span>
        {frame.payload.truncated ? (
          <span>
            ·{' '}
            {translate('components.native-chat.providerFrame.byteLength', '{{value0}} bytes', {
              value0: frame.payload.byteLength
            })}
          </span>
        ) : null}
      </summary>
      <pre className="scrollbar-sleek mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted p-2 font-mono text-xs text-foreground">
        {frame.payload.head}
        {frame.payload.truncated ? '\n…' : ''}
      </pre>
    </details>
  )
}
