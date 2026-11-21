import { ChevronLeft, ChevronRight, Copy, Download, MessageSquare, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/class-names'
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

const TOOL =
  'inline-flex h-7 min-w-7 items-center justify-center gap-1.5 rounded-[7px] border border-border bg-popover px-2 text-xs text-popover-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-media-note-ring disabled:opacity-55'

/** Title and the top-right tools: Annotate/Done, Notes (when hidden), Copy, Download, Close. */
export function NativeChatMediaViewerChrome({
  title,
  src,
  annotating,
  canAnnotate,
  panelHidden,
  noteCount,
  step,
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
  /** In a message's set of images: back and on, null at that end or while notes are open. */
  step: { previous: (() => void) | null; next: (() => void) | null } | null
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
            <button
              type="button"
              disabled={!step.previous}
              onClick={() => step.previous?.()}
              aria-label={t('auto.components.editor.PanZoomImageDialog.previous', 'Previous image')}
              title={t('auto.components.editor.PanZoomImageDialog.previous', 'Previous image')}
              className={TOOL}
            >
              <ChevronLeft className="size-3.5" />
            </button>
            <button
              type="button"
              disabled={!step.next}
              onClick={() => step.next?.()}
              aria-label={t('auto.components.editor.PanZoomImageDialog.next', 'Next image')}
              title={t('auto.components.editor.PanZoomImageDialog.next', 'Next image')}
              className={TOOL}
            >
              <ChevronRight className="size-3.5" />
            </button>
          </>
        ) : null}
        <button
          type="button"
          aria-pressed={annotating}
          disabled={!canAnnotate}
          onClick={onAnnotate}
          className={cn(
            TOOL,
            annotating && 'bg-media-note text-media-note-foreground hover:bg-media-note-hover'
          )}
        >
          <MessageSquare aria-hidden className="size-3.5" />
          {annotating
            ? t('components.native-chat.notes.done', 'Done')
            : t('components.native-chat.notes.annotate', 'Annotate')}
          <ShortcutKeyCombo size="compact" keys={[annotating ? 'Esc' : 'C']} onFill />
        </button>
        {panelHidden ? (
          <button
            type="button"
            onClick={onShowNotes}
            aria-label={t('components.native-chat.notes.showNotes', 'Show notes ({{count}})', {
              count: noteCount
            })}
            className={TOOL}
          >
            {t('components.native-chat.notes.title', 'Notes')}
            <span className="tabular-nums">{noteCount}</span>
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void copy()}
          disabled={!src}
          aria-label={t('components.native-chat.notes.copy', 'Copy image')}
          title={t('components.native-chat.notes.copy', 'Copy image')}
          className={TOOL}
        >
          <Copy className="size-3.5" />
        </button>
        <a
          href={src ?? undefined}
          download={title}
          aria-label={t('components.native-chat.notes.download', 'Download')}
          title={t('components.native-chat.notes.download', 'Download')}
          className={cn(TOOL, !src && 'pointer-events-none opacity-55')}
        >
          <Download className="size-3.5" />
        </a>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('components.native-chat.notes.close', 'Close')}
          title={t('components.native-chat.notes.close', 'Close')}
          className={TOOL}
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

/** Zoom out, the current zoom, zoom in, and Fit, at the bottom left. */
export function NativeChatMediaViewerZoom({
  panZoom
}: {
  panZoom: PanZoomViewport
}): React.JSX.Element {
  const t = useTranslate()
  const button =
    'h-6 min-w-6 rounded-[5px] px-1 text-xs text-popover-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-45'
  return (
    <div
      role="group"
      aria-label={t('components.native-chat.notes.zoom', 'Zoom')}
      className="absolute bottom-3 left-3 z-10 flex items-center gap-0.5 rounded-[7px] border border-border bg-popover px-1 py-0.5"
    >
      <button
        type="button"
        className={button}
        disabled={!panZoom.canZoomOut}
        aria-label={t('components.native-chat.notes.zoomOut', 'Zoom out')}
        onClick={() => panZoom.zoomBy(1 / IMAGE_VIEWER_ZOOM_STEP)}
      >
        −
      </button>
      <span
        aria-live="polite"
        className="min-w-10 text-center text-xs text-popover-foreground tabular-nums"
      >
        {Math.round(panZoom.scale * 100)}%
      </span>
      <button
        type="button"
        className={button}
        disabled={!panZoom.canZoomIn}
        aria-label={t('components.native-chat.notes.zoomIn', 'Zoom in')}
        onClick={() => panZoom.zoomBy(IMAGE_VIEWER_ZOOM_STEP)}
      >
        +
      </button>
      <button type="button" className={button} disabled={panZoom.isFitted} onClick={panZoom.fit}>
        {t('components.native-chat.notes.fit', 'Fit')}
      </button>
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
              ? 'flex-1 text-muted-foreground'
              : 'rounded-md bg-media-canvas/80 px-2 py-1 text-media-canvas-foreground'
          )}
        >
          {reason}
        </span>
      ) : null}
      <button
        type="button"
        disabled={!canSend}
        onClick={() => void onSend()}
        aria-describedby={reason ? 'native-chat-notes-send-reason' : undefined}
        aria-label={t(
          'components.native-chat.notes.sendLabel',
          'Send {{count}} notes to this chat',
          { defaultValue_one: 'Send {{count}} note to this chat', count }
        )}
        className="inline-flex h-[30px] items-center gap-2 rounded-[7px] bg-media-note px-3 text-sm text-media-note-foreground hover:bg-media-note-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-media-note-ring disabled:opacity-55"
      >
        {busy
          ? t('components.native-chat.notes.preparing', 'Preparing…')
          : t('components.native-chat.notes.send', 'Send')}
        <ShortcutKeyCombo
          size="compact"
          keys={isMacPlatform() ? ['⌘', '↵'] : ['Ctrl', '↵']}
          onFill
        />
      </button>
    </>
  )
}

/** Reads the image's natural size off screen, so the viewer can lay it out and draw on it. */
export function NativeChatMediaImageLoader({
  src,
  onLoaded
}: {
  src: string
  onLoaded: (loaded: { size: { width: number; height: number }; image: HTMLImageElement }) => void
}): React.JSX.Element {
  return (
    <img
      src={src}
      alt=""
      className="hidden"
      onLoad={(event) => {
        const image = event.currentTarget
        if (image.naturalWidth > 0) {
          onLoaded({ image, size: { width: image.naturalWidth, height: image.naturalHeight } })
        }
      }}
    />
  )
}
