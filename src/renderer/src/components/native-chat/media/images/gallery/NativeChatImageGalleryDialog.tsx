import { useId, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { PanZoomImageDialog } from '@/components/editor/document-images/PanZoomImageDialog'
import {
  acquireLocalImageSrcLease,
  getLocalImageSrcCacheKey,
  useLocalImageSrcResult
} from '@/components/editor/document-images/useLocalImageSrc'
import { blobUrlCache } from '@/components/editor/document-images/local-image-src-cache'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatFileLinkContext } from '../../../links/actions/native-chat-file-link-context'
import { copyableNativeChatImageSrc, keepPreviewOpenForChatMenu } from '../native-chat-image-copy'
import { NativeChatImageActionsMenu } from '../NativeChatImageActionsMenu'
import type { NativeChatGalleryEntry } from './native-chat-image-gallery-capture'
import type { NativeChatGalleryCloseReason } from './NativeChatImageGallery'

type StepDirection = 'previous' | 'next'

/** Moves focus a step or load took away: to an arrow after a step, otherwise the dialog itself. */
function recoverFocus(content: HTMLElement, direction: StepDirection | null): void {
  const active = document.activeElement
  const lost =
    !active ||
    active === document.body ||
    !active.isConnected ||
    (active instanceof HTMLButtonElement && active.disabled)
  if (!lost) {
    return
  }
  const arrow = (which: StepDirection): HTMLElement | null =>
    content.querySelector<HTMLElement>(`[data-image-step="${which}"]:not(:disabled)`)
  const target = direction
    ? (arrow(direction) ?? arrow(direction === 'next' ? 'previous' : 'next'))
    : null
  ;(target ?? content).focus({ preventScroll: true })
}

export function NativeChatImageGalleryDialog({
  open,
  entry,
  position,
  count,
  announcement,
  fileLinkContext,
  canStep,
  onStep,
  onClose,
  onCloseAutoFocus
}: {
  open: boolean
  entry: NativeChatGalleryEntry
  /** Among images whose messages are still loaded. */
  position: number
  count: number
  /** Said once per step; a count that later shrinks is not announced again. */
  announcement: string
  fileLinkContext: NativeChatFileLinkContext | null
  canStep: Record<StepDirection, boolean>
  onStep: (direction: StepDirection) => void
  onClose: (reason: NativeChatGalleryCloseReason) => void
  onCloseAutoFocus: (event: Event) => void
}): React.JSX.Element {
  const t = useTranslate()
  const descriptionId = useId()
  const [menuOpen, setMenuOpen] = useState(false)
  const handingOff = useRef(false)
  const stepDirection = useRef<StepDirection | null>(null)
  const menuWasOpen = useRef(false)
  const { image } = entry
  const local = image.source.kind === 'local' ? image.source : null
  const read = useLocalImageSrcResult(
    local?.rawSrc,
    local?.filePath ?? '',
    local?.connectionId,
    local?.runtimeContext,
    local?.access
  )
  // A cached image shows in the same frame as the step; only a read waits.
  const cacheKey = local
    ? getLocalImageSrcCacheKey(
        local.rawSrc,
        local.filePath,
        local.connectionId,
        local.runtimeContext,
        local.access
      )
    : null
  // Invalidation removes every entry it will revoke, so a URL still cached here stays valid.
  const cached = cacheKey ? blobUrlCache.get(cacheKey) : undefined
  const readable =
    image.source.kind === 'url' ? image.source.url : read.status === 'ready' ? read.src : cached
  // The payload that would not decode, not the image: a reread brings a new URL and another try.
  const [undecodable, setUndecodable] = useState<string | null>(null)
  const decoded = !readable || readable !== undecodable
  const src = decoded ? readable : undefined
  const failed = !decoded || (!readable && read.status === 'failed')
  // Copy waits for this entry's image to load: a loading or failed image offers none.
  const [loaded, setLoaded] = useState<{ key: string; src: string } | null>(null)
  const copySrc =
    src && loaded?.key === entry.key && loaded.src === src
      ? copyableNativeChatImageSrc(src)
      : undefined

  // Pin the next image before the previous one lets go: releasing can prune and revoke it.
  const lease = useRef<(() => void) | undefined>(undefined)
  useLayoutEffect(() => {
    const next = local
      ? acquireLocalImageSrcLease(
          local.rawSrc,
          local.filePath,
          local.connectionId,
          local.runtimeContext,
          local.access
        )
      : undefined
    const previous = lease.current
    lease.current = next
    previous?.()
  }, [local])
  useLayoutEffect(
    () => () => {
      lease.current?.()
      lease.current = undefined
    },
    []
  )

  useLayoutEffect(() => {
    const direction = stepDirection.current
    stepDirection.current = null
    const menuClosed = menuWasOpen.current && !menuOpen
    menuWasOpen.current = menuOpen
    // A closing menu restores its own trigger's focus on this commit.
    const content = document.querySelector('[data-native-chat-image-gallery]')
    if (!menuClosed && content instanceof HTMLElement) {
      recoverFocus(content, direction)
    }
  })

  const step = (direction: StepDirection): void => {
    setMenuOpen(false)
    stepDirection.current = direction
    onStep(direction)
  }
  const help = t(
    'components.native-chat.imageGallery.scopeHelp',
    "Images near this part of the chat when you opened the preview. Images further up or down aren't included. Close and reopen to update."
  )
  const chip = (text: string, status: boolean): React.ReactNode => (
    <span
      role={status ? 'status' : undefined}
      aria-busy={status ? undefined : true}
      className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
    >
      {text}
    </span>
  )

  return (
    <PanZoomImageDialog
      gallery
      data-native-chat-image-gallery=""
      aria-describedby={descriptionId}
      open={open}
      onOpenChange={(next) => !next && onClose('user')}
      src={src}
      imageKey={entry.key}
      onImageError={() => setUndecodable(readable ?? null)}
      onImageLoad={() => setLoaded(src ? { key: entry.key, src } : null)}
      title={image.title}
      showTitle
      fallback={
        failed
          ? chip(
              image.label
                ? t('components.native-chat.imageGallery.loadFailed', "Couldn't load {{name}}", {
                    name: image.label
                  })
                : t('components.native-chat.composer.imageUnavailable', 'Preview unavailable'),
              true
            )
          : chip(t('components.native-chat.imageGallery.loading', 'Loading image…'), false)
      }
      data-native-chat-copy-image-src={copySrc}
      onInteractOutside={keepPreviewOpenForChatMenu}
      onPrevious={canStep.previous ? () => step('previous') : null}
      onNext={canStep.next ? () => step('next') : null}
      onKeyDown={(event) => {
        // Arrows inside the actions menu move through it, never through the images.
        if (
          (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
          (menuOpen ||
            (event.target instanceof Element && event.target.closest('[role=menu],[role=listbox]')))
        ) {
          event.preventDefault()
        }
      }}
      onCloseAutoFocus={(event) => {
        if (handingOff.current) {
          event.preventDefault()
        }
        onCloseAutoFocus(event)
      }}
      stepStatus={
        <span
          aria-hidden
          title={help}
          className="px-1.5 text-xs whitespace-nowrap text-muted-foreground tabular-nums"
        >
          {position}
          <span className="max-[420px]:hidden"> </span>/
          <span className="max-[420px]:hidden"> </span>
          {count}
        </span>
      }
      liveContent={
        <>
          <p id={descriptionId} className="sr-only">
            {t(
              'components.native-chat.imageGallery.description',
              'Images in this view: {{position}} of {{count}}. {{help}}',
              {
                position,
                count,
                help
              }
            )}
          </p>
          <p className="sr-only" aria-live="polite" aria-atomic="true">
            {announcement}
          </p>
        </>
      }
      toolbarActions={
        image.actions ? (
          <NativeChatImageActionsMenu
            href={image.actions.href}
            isFile={image.actions.isFile}
            fileLinkContext={fileLinkContext}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            restoresFocus={() => !handingOff.current && open}
            onRun={(action) => {
              handingOff.current = true
              flushSync(() => {
                setMenuOpen(false)
                onClose('handoff')
              })
              void action.run()
            }}
          />
        ) : null
      }
    />
  )
}
