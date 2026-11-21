import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/class-names'
import { isMacPlatform } from '@/components/native-chat/pane/routing/native-chat-shortcut'
import { useTranslate } from '@/i18n/use-translate'
import { usePanZoomViewport } from '@/components/editor/viewer-viewport/use-pan-zoom-viewport'
import type { PanZoomSize } from '../../../../../../shared/document-preview/pan-zoom-view'
import { NativeChatMediaMarks } from './NativeChatMediaMarks'
import { NativeChatMediaNotesPanel } from './NativeChatMediaNotesPanel'
import {
  NativeChatMediaImageLoader,
  NativeChatMediaViewerChrome,
  NativeChatMediaViewerZoom,
  NativeChatNotesSendButton as SendButton
} from './NativeChatMediaViewerChrome'
import { useNativeChatNotesEditor } from './use-native-chat-notes-editor'
import { nativeChatNoteTimesNeedTenths, type NativeChatMediaNote } from './native-chat-media-notes'
import type { NativeChatNotesSource } from './native-chat-attachment-notes'
import { useNativeChatNotesDelivery } from './use-native-chat-notes-delivery'
import { useViewerZoomCommands } from '@/components/editor/viewer-viewport/use-viewer-zoom-commands'
import {
  focusNativeChatMediaViewportSoon,
  handleNativeChatMediaViewportKey
} from './native-chat-media-viewport-keys'

/** Below this width the notes panel becomes a bottom sheet. */
const NARROW_WIDTH = 720

export type NativeChatMediaViewerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Displayable, same-origin source (a blob or data URL), so the marked image can be drawn. */
  src: string | null
  title: string
  source: NativeChatNotesSource
  /** An element inside the chat, used to find its message box. */
  opener: React.RefObject<Element | null>
  /** Reopening a marked image: its notes, editable again on the original. */
  initialNotes?: readonly NativeChatMediaNote[]
  offset?: number
  /** The marked images a hand-off attached; a returned function undoes what the caller replaced. */
  onAttached?: (ids: string[]) => (() => void) | void
  /** A reopened marked image whose notes were all deleted on close; returns its Undo. */
  onCleared?: () => () => void
  /** The draft image these notes replace (a chip opened from the message box). */
  replacesAttachmentId?: string
  fallback?: React.ReactNode
  /** False for web images: drawing them would need a cross-origin read, so they are view-only. */
  annotatable?: boolean
  /** Keeps the viewer open while the chat's own image menu is used over it. */
  onInteractOutside?: React.ComponentProps<typeof DialogContent>['onInteractOutside']
  /** The image the chat's context menu copies. */
  copySrc?: string
  /** In a message's set of images: back and on, by the arrows or ← and →; null at that end. */
  onPrevious?: (() => void) | null
  /** Which of the message's images this is. */
  position?: { index: number; count: number }
  onNext?: (() => void) | null
}

/** Full-window image viewer with notes: Annotate, numbered pins and boxes, a Notes panel and Send. */
export function NativeChatMediaViewer(props: NativeChatMediaViewerProps): React.JSX.Element {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {/* Each image starts fresh: its size, zoom and notes are its own. */}
      {props.open ? <ViewerBody key={props.source.path ?? props.source.url} {...props} /> : null}
    </Dialog>
  )
}

function ViewerBody({
  onOpenChange,
  src,
  title,
  source,
  opener,
  initialNotes,
  offset = 0,
  onAttached,
  onCleared,
  replacesAttachmentId,
  fallback,
  annotatable = true,
  onInteractOutside,
  copySrc,
  onPrevious,
  onNext,
  position
}: NativeChatMediaViewerProps): React.JSX.Element {
  const editor = useNativeChatNotesEditor({ notes: initialNotes ?? [], offset })
  const [annotating, setAnnotating] = useState(Boolean(initialNotes?.length))
  const [panelHidden, setPanelHidden] = useState(false)
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_WIDTH)
  const [loaded, setLoaded] = useState<{ size: PanZoomSize; image: HTMLImageElement } | null>(null)
  const panZoom = usePanZoomViewport({ content: loaded?.size ?? null, contain: true })
  // ⌘+ ⌘− ⌘0 zoom here as in Orca's other image viewers.
  useViewerZoomCommands(panZoom, 'popup')
  const [broken, setBroken] = useState(false)
  const openerFocus = useRef<Element | null>(null)
  // Set when the close prompt is answered: the viewer closes once the answered note is settled.
  const closeRequested = useRef(false)
  const { setCanvas, canvasHandlers, cursor, scale, offset: viewOffset } = panZoom
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const t = useTranslate()
  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < NARROW_WIDTH)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  // Phones view sent notes; making notes needs a pointer and a keyboard, so they get no Annotate.
  const phone = window.matchMedia('(pointer: coarse)').matches
  const canAnnotate = annotatable && Boolean(loaded) && !phone
  const annotateReason = annotatable
    ? null
    : t('components.native-chat.notes.annotateUnavailable', 'Notes can’t be drawn on this image.')
  const { notes } = editor
  // The unzoomed viewport takes focus, so its ring always shows whole, at any zoom.
  const focusMedia = (): void => viewportRef.current?.focus({ preventScroll: true })
  const resumeAnnotating = useCallback(() => setAnnotating(true), [])
  const showPanel = useCallback(() => setPanelHidden(false), [])
  const { busy, canSend, sendReason, close, send } = useNativeChatNotesDelivery({
    opener,
    loaded,
    editor,
    title,
    source,
    offset,
    initialNotes,
    onAttached,
    onCleared,
    replacesAttachmentId,
    onOpenChange,
    showPanel,
    onRestored: resumeAnnotating
  })
  // Stepping away would drop notes in progress, so it waits until there are none.
  const stepping = notes.length === 0 && !editor.pending
  const step =
    position && (onPrevious !== undefined || onNext !== undefined)
      ? {
          previous: stepping ? (onPrevious ?? null) : null,
          next: stepping ? (onNext ?? null) : null,
          ...position,
          blockedReason: stepping
            ? null
            : t(
                'components.native-chat.notes.stepBlocked',
                'Send or close notes to move between images'
              )
        }
      : null

  useEffect(() => {
    if (closeRequested.current && !editor.hasUnadded && !editor.confirm) {
      closeRequested.current = false
      void close()
    }
  }, [close, editor.confirm, editor.hasUnadded])
  const finishAnnotating = (): void => {
    if (editor.hasUnadded) {
      setPanelHidden(false)
      editor.setConfirm({ reason: 'done' })
      return
    }
    editor.closeEditor()
    setAnnotating(false)
  }
  const place: typeof editor.place = (mark, time) => {
    setPanelHidden(false)
    return editor.place(mark, time)
  }

  return (
    <DialogContent
      aria-describedby={undefined}
      showCloseButton={false}
      onInteractOutside={onInteractOutside}
      data-native-chat-copy-image-src={copySrc}
      surface="media-canvas"
      onOpenAutoFocus={(event) => {
        // Focus starts on the media, not on the first toolbar button, and returns to the opener.
        openerFocus.current = document.activeElement
        event.preventDefault()
        focusMedia()
      }}
      onCloseAutoFocus={(event) => {
        const previous = openerFocus.current
        if (previous instanceof HTMLElement && previous.isConnected) {
          event.preventDefault()
          previous.focus({ preventScroll: true })
        }
      }}
      onEscapeKeyDown={(event) => {
        // Esc steps back one layer: the prompt, the note editor, annotating, then the viewer.
        event.preventDefault()
        if (editor.confirm) {
          editor.setConfirm(null)
        } else if (editor.pending || editor.editing) {
          if (editor.hasUnadded) {
            setPanelHidden(false)
            editor.setConfirm({ reason: 'cancel' })
          } else {
            editor.closeEditor()
            focusMedia()
          }
        } else if (annotating) {
          finishAnnotating()
        } else {
          void close()
        }
      }}
      onKeyDown={(event) => {
        const typing =
          event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement
        if (event.key === 'Enter' && (isMacPlatform() ? event.metaKey : event.ctrlKey)) {
          event.preventDefault()
          void send()
        } else if (
          !typing &&
          event.key.toLowerCase() === 'z' &&
          (isMacPlatform() ? event.metaKey : event.ctrlKey)
        ) {
          // ⌘Z / Ctrl+Z undoes any change to the notes; with Shift it redoes, as in Orca's markup.
          if (event.shiftKey ? editor.redo() : editor.undo()) {
            event.preventDefault()
          }
        } else if (
          !typing &&
          event.key === 'c' &&
          !event.metaKey &&
          !event.ctrlKey &&
          canAnnotate
        ) {
          event.preventDefault()
          if (annotating) {
            finishAnnotating()
          } else {
            setAnnotating(true)
            focusNativeChatMediaViewportSoon(viewportRef.current)
          }
        } else if (!typing && step && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
          const go = event.key === 'ArrowLeft' ? step.previous : step.next
          if (go && !event.altKey && !event.metaKey && !event.ctrlKey) {
            event.preventDefault()
            go()
          }
        } else if (
          !typing &&
          event.key === 'C' &&
          event.shiftKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          annotating
        ) {
          event.preventDefault()
          setPanelHidden((hidden) => !hidden)
        }
      }}
    >
      <DialogTitle className="sr-only">{title}</DialogTitle>
      <NativeChatMediaViewerChrome
        title={title}
        src={src}
        annotating={annotating}
        canAnnotate={canAnnotate}
        panelHidden={annotating && panelHidden}
        noteCount={notes.length}
        step={step}
        annotateReason={annotateReason}
        annotateHidden={phone}
        onAnnotate={() =>
          annotating
            ? finishAnnotating()
            : (setAnnotating(true), focusNativeChatMediaViewportSoon(viewportRef.current))
        }
        onShowNotes={() => setPanelHidden(false)}
        onClose={() => void close()}
      />
      <div
        className={cn(
          'absolute top-13 right-4 bottom-14 left-4',
          annotating && !panelHidden && !narrow && 'right-[22rem]',
          annotating && !panelHidden && narrow && 'bottom-[54%]'
        )}
      >
        <div
          ref={(element) => {
            viewportRef.current = element
            setCanvas(element)
          }}
          {...canvasHandlers}
          tabIndex={0}
          role={annotating ? 'application' : undefined}
          aria-label={
            annotating
              ? t(
                  'components.native-chat.notes.mediaLabel',
                  'Media. Click to pin a spot or drag to box an area; Enter pins the center.'
                )
              : title
          }
          onKeyDown={(event) => {
            if (handleNativeChatMediaViewportKey(event, { panZoom, annotating, onPlace: place })) {
              event.preventDefault()
              event.stopPropagation()
            }
          }}
          className={cn(
            'relative size-full touch-none overflow-hidden rounded-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-media-note-ring',
            !annotating && cursor === 'grab' && 'cursor-grab'
          )}
        >
          {src && viewOffset && loaded ? (
            <div
              className="absolute top-0 left-0"
              style={{
                width: loaded.size.width * scale,
                height: loaded.size.height * scale,
                transform: `translate(${viewOffset.x}px, ${viewOffset.y}px)`
              }}
            >
              <img
                src={src}
                alt={title}
                draggable={false}
                className="pointer-events-none size-full select-none rounded-sm"
              />
              <div className="absolute inset-0">
                <NativeChatMediaMarks
                  notes={notes}
                  pending={editor.pending}
                  selectedId={editor.editing?.id ?? editor.pending?.id ?? null}
                  annotating={annotating}
                  onPlace={(mark) => place(mark)}
                  onOpen={(id) => {
                    setPanelHidden(false)
                    editor.open(id)
                  }}
                  onMove={editor.move}
                />
              </div>
            </div>
          ) : null}
          {src && !loaded && !broken ? (
            <NativeChatMediaImageLoader
              src={src}
              onLoaded={setLoaded}
              onError={() => setBroken(true)}
            />
          ) : null}
          {!src || broken ? (
            <div className="flex size-full items-center justify-center">{fallback}</div>
          ) : null}
        </div>
      </div>
      {/* Above the narrow sheet while it is open, so zoom and Fit stay at hand. */}
      <NativeChatMediaViewerZoom
        panZoom={panZoom}
        aboveSheet={narrow && annotating && !panelHidden}
      />
      {annotating && !panelHidden ? (
        <div
          className={cn(
            'absolute z-10',
            narrow
              ? 'inset-x-0 bottom-0 flex max-h-[54%] flex-col'
              : 'top-13 right-3 flex max-h-[calc(100%-7rem)]'
          )}
        >
          <NativeChatMediaNotesPanel
            editor={editor}
            preciseTimes={nativeChatNoteTimesNeedTenths(notes)}
            narrow={narrow}
            onHide={() => setPanelHidden(true)}
            onConfirmed={(reason) => {
              if (reason === 'close') {
                // Closes on the next render, once the answered note is added or gone.
                closeRequested.current = true
              } else if (reason === 'done') {
                setAnnotating(false)
              } else {
                focusMedia()
              }
            }}
            onEditorClosed={focusMedia}
            sendSlot={
              notes.length > 0 ? (
                <SendButton
                  canSend={canSend}
                  busy={busy}
                  reason={sendReason}
                  count={notes.length}
                  onSend={send}
                  inSheet
                />
              ) : null
            }
          />
        </div>
      ) : null}
      {notes.length > 0 && !(narrow && annotating && !panelHidden) ? (
        <div className="absolute right-3 bottom-3 z-10 flex max-w-[calc(100%-1.5rem)] items-center gap-2.5">
          <SendButton
            canSend={canSend}
            busy={busy}
            reason={sendReason}
            count={notes.length}
            onSend={send}
          />
        </div>
      ) : null}
    </DialogContent>
  )
}
