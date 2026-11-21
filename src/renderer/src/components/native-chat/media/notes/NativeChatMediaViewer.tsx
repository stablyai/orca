import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/class-names'
import { handleNativeChatMediaViewerKey } from './native-chat-media-viewer-keys'
import { useTranslate } from '@/i18n/use-translate'
import { usePanZoomViewport } from '@/components/editor/viewer-viewport/use-pan-zoom-viewport'
import type { NativeChatMediaLoaded } from './native-chat-notes-handoff'
import { NativeChatImageStage } from './NativeChatImageStage'
import { NativeChatVideoStage } from './video/NativeChatVideoStage'
import { NativeChatMediaMarks } from './NativeChatMediaMarks'
import { NativeChatMediaNotesPanel } from './NativeChatMediaNotesPanel'
import {
  NativeChatMediaViewerChrome,
  NativeChatMediaViewerZoom,
  NativeChatNotesSendButton as SendButton
} from './NativeChatMediaViewerChrome'
import { useNativeChatNotesEditor } from './use-native-chat-notes-editor'
import {
  nativeChatNoteTimesNeedTenths,
  type NativeChatMediaNote,
  type NativeChatNoteMark
} from './native-chat-media-notes'
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
  /** A video: played under its frame, with each note on the frame it was made on. */
  kind?: 'image' | 'video'
  /** A video opened from a link: its editor tab instead. */
  onOpenInEditor?: () => void
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
  position,
  kind = 'image',
  onOpenInEditor
}: NativeChatMediaViewerProps): React.JSX.Element {
  const editor = useNativeChatNotesEditor({ notes: initialNotes ?? [], offset })
  const [annotating, setAnnotating] = useState(Boolean(initialNotes?.length))
  const [panelHidden, setPanelHidden] = useState(false)
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_WIDTH)
  const [loaded, setLoaded] = useState<NativeChatMediaLoaded | null>(null)
  // A video isn't zoomed: its frames are captured as shown, whole.
  const panZoom = usePanZoomViewport({
    content: kind === 'image' ? (loaded?.size ?? null) : null,
    contain: true
  })
  const placeAtFrame = useRef<((mark: NativeChatNoteMark) => void) | null>(null)
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

  const openNote = (id: string): void => {
    setPanelHidden(false)
    editor.open(id)
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
      onKeyDown={(event) =>
        handleNativeChatMediaViewerKey(event, {
          send: () => void send(),
          undo: editor.undo,
          redo: editor.redo,
          canAnnotate,
          annotating,
          toggleAnnotating: () =>
            annotating
              ? finishAnnotating()
              : (setAnnotating(true), focusNativeChatMediaViewportSoon(viewportRef.current)),
          step,
          togglePanel: () => setPanelHidden((hidden) => !hidden)
        })
      }
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
        onOpenInEditor={onOpenInEditor}
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
          {...(kind === 'image' ? canvasHandlers : {})}
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
            const onPlace =
              kind === 'video' ? (mark: NativeChatNoteMark) => placeAtFrame.current?.(mark) : place
            if (handleNativeChatMediaViewportKey(event, { panZoom, annotating, onPlace })) {
              event.preventDefault()
              event.stopPropagation()
            }
          }}
          className={cn(
            'relative size-full touch-none overflow-hidden rounded-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-media-note-ring',
            !annotating && cursor === 'grab' && 'cursor-grab'
          )}
        >
          {kind === 'video' ? (
            <NativeChatVideoStage
              src={src}
              title={title}
              annotating={annotating}
              notes={notes}
              focusTime={editor.editing?.time}
              marks={{
                pending: editor.pending,
                selectedId: editor.editing?.id ?? editor.pending?.id ?? null,
                annotating,
                onOpen: openNote,
                onMove: editor.move
              }}
              onLoaded={setLoaded}
              onBroken={() => setBroken(true)}
              broken={broken}
              fallback={fallback}
              placeRef={placeAtFrame}
              place={(mark, time) => void place(mark, time)}
              onCaptureFailed={() =>
                editor.setStatus({
                  kind: 'error',
                  message: t(
                    'components.native-chat.notes.captureFailed',
                    'Couldn’t capture this frame. Try again.'
                  )
                })
              }
            />
          ) : (
            <NativeChatImageStage
              src={src}
              title={title}
              loaded={loaded}
              onLoaded={setLoaded}
              broken={broken}
              onBroken={() => setBroken(true)}
              fallback={fallback}
              scale={scale}
              offset={viewOffset}
              marks={
                <NativeChatMediaMarks
                  notes={notes}
                  pending={editor.pending}
                  selectedId={editor.editing?.id ?? editor.pending?.id ?? null}
                  annotating={annotating}
                  onPlace={(mark) => void place(mark)}
                  onOpen={openNote}
                  onMove={editor.move}
                />
              }
            />
          )}
        </div>
      </div>
      {/* Above the narrow sheet while it is open, so zoom and Fit stay at hand. */}
      {kind === 'image' ? (
        <NativeChatMediaViewerZoom
          panZoom={panZoom}
          aboveSheet={narrow && annotating && !panelHidden}
        />
      ) : null}
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
