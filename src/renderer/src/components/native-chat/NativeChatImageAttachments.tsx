import { Image as ImageIcon, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import { useLocalImageSrc, releaseLocalImageSrc } from '@/components/editor/useLocalImageSrc'
import { ImagePreviewDialog, type ImagePreview } from '../image-preview/ImagePreviewDialog'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { getConnectionIdForFileFromState } from '@/lib/connection-owner-resolution'

export type NativeChatImageAttachment = {
  id: string
  fileName: string
  path?: string
  url?: string
}

export type NativeChatImageLoadContext = {
  disabled?: boolean
  connectionId?: string | null
  runtimeContext?: Omit<RuntimeFileOperationArgs, 'connectionId'> & {
    connectionId?: string | null
  }
}

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

type ResolvedImage = NativeChatImageAttachment & { src: string }

export function NativeChatImageAttachments({
  images,
  loadContext,
  onRemove,
  compact = false
}: {
  images: readonly NativeChatImageAttachment[]
  loadContext?: NativeChatImageLoadContext
  onRemove?: (id: string) => void
  compact?: boolean
}): React.JSX.Element | null {
  const [sources, setSources] = useState<Record<string, string | undefined>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const registerSource = useCallback((id: string, src: string | undefined) => {
    setSources((current) => (current[id] === src ? current : { ...current, [id]: src }))
  }, [])
  const resolved = useMemo(
    () =>
      images.flatMap((image): ResolvedImage[] => {
        const src = sources[image.id]
        return src ? [{ ...image, src }] : []
      }),
    [images, sources]
  )
  const selectedIndex = resolved.findIndex((image) => image.id === selectedId)
  const selected = selectedIndex !== -1 ? resolved[selectedIndex] : null
  const preview: ImagePreview | null = selected
    ? {
        fileName: selected.fileName,
        src: selected.src,
        onDownload: () => downloadImage(selected.src, selected.fileName),
        onPrevious:
          selectedIndex > 0 ? () => setSelectedId(resolved[selectedIndex - 1].id) : undefined,
        onNext:
          selectedIndex < resolved.length - 1
            ? () => setSelectedId(resolved[selectedIndex + 1].id)
            : undefined
      }
    : null

  if (images.length === 0) {
    return null
  }
  return (
    <>
      <div className={compact ? 'flex flex-wrap gap-1' : 'mb-2 flex flex-wrap gap-1.5'}>
        {images.map((image) => (
          <NativeChatImageThumbnail
            key={image.id}
            image={image}
            loadContext={loadContext}
            previewOpen={selectedId !== null}
            onResolved={registerSource}
            onOpen={() => setSelectedId(image.id)}
            onRemove={onRemove ? () => onRemove(image.id) : undefined}
            compact={compact}
          />
        ))}
      </div>
      <ImagePreviewDialog preview={preview} onOpenChange={(open) => !open && setSelectedId(null)} />
    </>
  )
}

function NativeChatImageThumbnail({
  image,
  loadContext,
  onResolved,
  onOpen,
  onRemove,
  compact,
  previewOpen
}: {
  image: NativeChatImageAttachment
  loadContext?: NativeChatImageLoadContext
  onResolved: (id: string, src: string | undefined) => void
  onOpen: () => void
  onRemove?: () => void
  compact: boolean
  previewOpen: boolean
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const leaseActive = near || previewOpen
  useEffect(() => {
    const element = ref.current
    return element ? observeTranscriptVisibility(element, setNear) : undefined
  }, [])
  const runtimeContext = loadContext?.runtimeContext
  const runtimeEnvironmentId = runtimeContext?.settings?.activeRuntimeEnvironmentId?.trim()
  const connectionId = useAppStore((state) =>
    loadContext?.connectionId !== undefined
      ? loadContext.connectionId
      : runtimeContext?.connectionId !== undefined
        ? runtimeContext.connectionId
        : image.path && runtimeContext?.worktreeId && !runtimeEnvironmentId
          ? getConnectionIdForFileFromState(state, runtimeContext.worktreeId, image.path)
          : loadContext?.connectionId
  )
  const ownerUnresolved =
    Boolean(image.path && runtimeContext?.worktreeId && !runtimeEnvironmentId) &&
    connectionId === undefined &&
    !runtimeContext?.expectedExecutionHostId
  const rawSrc = image.url ?? (loadContext?.disabled || ownerUnresolved ? undefined : image.path)
  const src = useLocalImageSrc(
    leaseActive ? rawSrc : undefined,
    image.path ?? '',
    connectionId,
    runtimeContext
  )
  useEffect(() => {
    if (!rawSrc) {
      return
    }
    if (!leaseActive) {
      releaseLocalImageSrc(rawSrc, image.path ?? '', connectionId, runtimeContext)
    }
    return () => releaseLocalImageSrc(rawSrc, image.path ?? '', connectionId, runtimeContext)
  }, [rawSrc, image.path, connectionId, runtimeContext, leaseActive])
  const displaySrc = leaseActive && src !== failedSrc ? src : undefined
  useEffect(() => {
    onResolved(image.id, displaySrc)
    return () => onResolved(image.id, undefined)
  }, [image.id, onResolved, displaySrc])
  return (
    <div
      ref={ref}
      className={compact ? 'relative size-6 shrink-0' : 'relative size-20 shrink-0'}
      title={image.path ?? image.url ?? image.fileName}
    >
      <button
        type="button"
        className="size-full overflow-hidden rounded-lg border border-border bg-muted/30 text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default"
        onClick={onOpen}
        disabled={!displaySrc}
        aria-label={image.fileName}
      >
        {displaySrc ? (
          <img
            src={displaySrc}
            alt={image.fileName}
            loading="lazy"
            onError={() => setFailedSrc(displaySrc ?? null)}
            className="size-full object-cover"
          />
        ) : (
          <ImageIcon className={compact ? 'mx-auto size-3.5' : 'mx-auto size-6'} />
        )}
      </button>
      {onRemove && !compact ? (
        <button
          type="button"
          className="absolute top-1 right-1 z-10 flex size-4 items-center justify-center rounded-full bg-foreground text-background shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={onRemove}
          aria-label={translate(
            'components.native-chat.composer.removeAttachment',
            'Remove attachment'
          )}
        >
          <X className="size-3" />
        </button>
      ) : null}
    </div>
  )
}

function downloadImage(src: string, fileName: string): void {
  const anchor = document.createElement('a')
  anchor.href = src
  anchor.download = fileName
  anchor.click()
}
