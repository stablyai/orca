import { ChevronLeft, ChevronRight, Copy, Download, MessageSquare, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/class-names'
import { Button } from '@/components/ui/button'
import { ShortcutKeyCombo } from '@/components/ui/ShortcutKeyCombo'
import { isMacPlatform } from '@/components/native-chat/pane/routing/native-chat-shortcut'
import { useTranslate } from '@/i18n/use-translate'
import {
  clipboardImageCopyErrorDescription,
  imageCopyFailedMessage
} from '@/lib/clipboard/images/clipboard-image-copy'
import type { PanZoomViewport } from '@/components/editor/viewer-viewport/use-pan-zoom-viewport'
import { IMAGE_VIEWER_ZOOM_STEP } from '@/components/editor/viewer-viewport/image-viewer-zoom'
import { imageClipboardPngDataUrl } from '@/components/editor/document-images/image-png-export'

/** Title and the top-right tools: Annotate/Done, Notes (when hidden), Copy, Download, Close. */
export function NativeChatMediaViewerChrome({
  title,
  src,
  annotating,
  canAnnotate,
  panelHidden,
  noteCount,
  step,
  annotateReason,
  annotateHidden,
  onAnnotate,
  onShowNotes,
  onClose
}: {
  title: string
  src: string | null
  annotating: boolean
  canAnnotate: boolean
  panelHidden: boolean
  noteCount: number
  /** In a message's set of images: back and on (null at that end), which image this is, and why the
   *  arrows wait when notes are open. */
  step: {
    previous: (() => void) | null
    next: (() => void) | null
    index: number
    count: number
    blockedReason: string | null
  } | null
  /** Why notes can't be made here. */
  annotateReason: string | null
  /** Annotate is left out entirely (phones view notes only). */
  annotateHidden: boolean
  onAnnotate: () => void
  onShowNotes: () => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const copy = async (): Promise<void> => {
    if (!src) {
      return
    }
    try {
      const image = new Image()
      image.src = src
      await image.decode()
      await window.api.ui.writeClipboardImage(
        await imageClipboardPngDataUrl(
          src,
          { width: image.naturalWidth, height: image.naturalHeight },
          null
        )
      )
      toast.success(t('components.native-chat.notes.copied', 'Copied as PNG'))
    } catch (error) {
      toast.error(imageCopyFailedMessage(), {
        description: clipboardImageCopyErrorDescription(error)
      })
    }
  }
  return (
    <div className="absolute inset-x-0 top-0 z-20 flex h-13 items-center gap-2 pr-3 pl-4">
      <div
        className="min-w-0 flex-1 truncate text-xs text-media-canvas-foreground/80"
        title={title}
      >
        {title}
      </div>
      <div className="flex shrink-0 gap-1.5">
        {step ? (
          <>
            <span className="self-center px-1 text-xs text-media-canvas-foreground/80 tabular-nums">
              {t('components.native-chat.notes.imageIndex', '{{index}} / {{total}}', {
                index: step.index + 1,
                total: step.count
              })}
            </span>
            <Button
              type="button"
              // Not `disabled`: a disabled button shows no tooltip, and this one says why.
              aria-disabled={!step.previous}
              onClick={() => step.previous?.()}
              aria-label={t('auto.components.editor.PanZoomImageDialog.previous', 'Previous image')}
              title={
                step.blockedReason ??
                t('auto.components.editor.PanZoomImageDialog.previous', 'Previous image')
              }
              variant="media-tool"
              size="icon-sm"
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <Button
              type="button"
              aria-disabled={!step.next}
              onClick={() => step.next?.()}
              aria-label={t('auto.components.editor.PanZoomImageDialog.next', 'Next image')}
              title={
                step.blockedReason ??
                t('auto.components.editor.PanZoomImageDialog.next', 'Next image')
              }
              variant="media-tool"
              size="icon-sm"
            >
              <ChevronRight className="size-3.5" />
            </Button>
          </>
        ) : null}
        {annotateHidden ? null : (
          <Button
            type="button"
            aria-pressed={annotating}
            aria-disabled={!canAnnotate}
            title={canAnnotate ? undefined : (annotateReason ?? undefined)}
            onClick={() => canAnnotate && onAnnotate()}
            variant={annotating ? 'media-note' : 'media-tool'}
            size="sm"
          >
            <MessageSquare aria-hidden className="size-3.5" />
            {annotating
              ? t('components.native-chat.notes.done', 'Done')
              : t('components.native-chat.notes.annotate', 'Annotate')}
            <ShortcutKeyCombo size="compact" keys={[annotating ? 'Esc' : 'C']} onFill />
          </Button>
        )}
        {panelHidden ? (
          <Button
            type="button"
            onClick={onShowNotes}
            aria-label={t('components.native-chat.notes.showNotes', 'Show notes ({{count}})', {
              count: noteCount
            })}
            variant="media-tool"
            size="sm"
          >
            {t('components.native-chat.notes.title', 'Notes')}
            <span className="tabular-nums">{noteCount}</span>
          </Button>
        ) : null}
        <Button
          type="button"
          onClick={() => void copy()}
          aria-disabled={!src}
          aria-label={t('components.native-chat.notes.copy', 'Copy image')}
          title={t('components.native-chat.notes.copy', 'Copy image')}
          variant="media-tool"
          size="icon-sm"
        >
          <Copy className="size-3.5" />
        </Button>
        <Button
          asChild
          variant="media-tool"
          size="icon-sm"
          aria-disabled={!src}
          className={cn(!src && 'pointer-events-none')}
        >
          <a
            href={src ?? undefined}
            download={title}
            aria-label={t('components.native-chat.notes.download', 'Download')}
            title={t('components.native-chat.notes.download', 'Download')}
          >
            <Download className="size-3.5" />
          </a>
        </Button>
        <Button
          type="button"
          onClick={onClose}
          aria-label={t('components.native-chat.notes.close', 'Close')}
          title={t('components.native-chat.notes.close', 'Close')}
          variant="media-tool"
          size="icon-sm"
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}

/** Zoom out, the current zoom, zoom in, and Fit, at the bottom left. */
export function NativeChatMediaViewerZoom({
  panZoom,
  aboveSheet = false
}: {
  panZoom: PanZoomViewport
  /** The narrow notes sheet covers the bottom of the viewer; sit just above it. */
  aboveSheet?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      role="group"
      aria-label={t('components.native-chat.notes.zoom', 'Zoom')}
      className={cn(
        'absolute left-3 z-10 flex items-center gap-0.5 rounded-md border border-media-paper-border bg-media-paper px-1 py-0.5',
        aboveSheet ? 'bottom-[calc(52%+0.75rem)]' : 'bottom-3'
      )}
    >
      <Button
        type="button"
        variant="media-paper-ghost"
        size="icon-xs"
        disabled={!panZoom.canZoomOut}
        aria-label={t('components.native-chat.notes.zoomOut', 'Zoom out')}
        onClick={() => panZoom.zoomBy(1 / IMAGE_VIEWER_ZOOM_STEP)}
      >
        −
      </Button>
      <span
        aria-live="polite"
        className="min-w-10 text-center text-xs text-media-paper-foreground tabular-nums"
      >
        {Math.round(panZoom.scale * 100)}%
      </span>
      <Button
        type="button"
        variant="media-paper-ghost"
        size="icon-xs"
        disabled={!panZoom.canZoomIn}
        aria-label={t('components.native-chat.notes.zoomIn', 'Zoom in')}
        onClick={() => panZoom.zoomBy(IMAGE_VIEWER_ZOOM_STEP)}
      >
        +
      </Button>
      <Button
        type="button"
        variant="media-paper-ghost"
        size="xs"
        disabled={panZoom.isFitted}
        onClick={panZoom.fit}
      >
        {t('components.native-chat.notes.fit', 'Fit')}
      </Button>
    </div>
  )
}

/** Send at the bottom right (in the sheet when narrow), with why it is unavailable beside it. */
export function NativeChatNotesSendButton({
  canSend,
  busy,
  reason,
  count,
  onSend,
  inSheet = false
}: {
  canSend: boolean
  busy: boolean
  reason: string | null
  count: number
  onSend: () => Promise<void>
  inSheet?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      {reason ? (
        <span
          id="native-chat-notes-send-reason"
          className={cn(
            'text-xs',
            inSheet
              ? 'flex-1 text-media-paper-muted'
              : 'rounded-md bg-media-canvas/80 px-2 py-1 text-media-canvas-foreground'
          )}
        >
          {reason}
        </span>
      ) : null}
      <Button
        type="button"
        variant="media-note"
        size="sm"
        disabled={!canSend}
        onClick={() => void onSend()}
        aria-describedby={reason ? 'native-chat-notes-send-reason' : undefined}
        aria-label={t(
          'components.native-chat.notes.sendLabel',
          'Send {{count}} notes to this chat',
          { defaultValue_one: 'Send {{count}} note to this chat', count }
        )}
      >
        {busy
          ? t('components.native-chat.notes.preparing', 'Preparing…')
          : t('components.native-chat.notes.send', 'Send')}
        <ShortcutKeyCombo
          size="compact"
          keys={isMacPlatform() ? ['⌘', '↵'] : ['Ctrl', '↵']}
          onFill
        />
      </Button>
    </>
  )
}

/** Reads the image's natural size off screen, so the viewer can lay it out and draw on it. */
export function NativeChatMediaImageLoader({
  src,
  onLoaded,
  onError
}: {
  src: string
  /** The file is missing or isn't an image: the viewer shows its fallback instead. */
  onError: () => void
  onLoaded: (loaded: { size: { width: number; height: number }; image: HTMLImageElement }) => void
}): React.JSX.Element {
  return (
    <img
      src={src}
      alt=""
      className="hidden"
      onError={onError}
      onLoad={(event) => {
        const image = event.currentTarget
        if (image.naturalWidth > 0) {
          onLoaded({ image, size: { width: image.naturalWidth, height: image.naturalHeight } })
        }
      }}
    />
  )
}
