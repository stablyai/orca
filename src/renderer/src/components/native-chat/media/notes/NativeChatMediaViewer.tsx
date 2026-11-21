import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/class-names'
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
import {
  afterComposerRender,
  attachNativeChatNotes,
  detachNativeChatNotes,
  nativeChatNotesComposer,
  nativeChatNotesStillInDraft,
  watchNativeChatNotesLeaveDraft,
  type NativeChatNotesComposer
} from './native-chat-notes-handoff'
import { holdNativeChatNotes, takeHeldNativeChatNotes } from './native-chat-held-notes'

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
  /** The marked images a hand-off attached, so a reopened chip can be replaced by them. */
  onAttached?: (ids: string[]) => void
  fallback?: React.ReactNode
  /** False for web images: drawing them would need a cross-origin read, so they are view-only. */
  annotatable?: boolean
  /** Keeps the viewer open while the chat's own image menu is used over it. */
  onInteractOutside?: React.ComponentProps<typeof DialogContent>['onInteractOutside']
  /** The image the chat's context menu copies. */
  copySrc?: string
  /** In a message's set of images: back and on, by the arrows or ← and →; null at that end. */
  onPrevious?: (() => void) | null
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
  fallback,
  annotatable = true,
  onInteractOutside,
  copySrc,
  onPrevious,
  onNext
}: NativeChatMediaViewerProps): React.JSX.Element {
  const t = useTranslate()
  const sourceKey = source.path ?? source.url ?? title
  const [held] = useState(() => (initialNotes ? null : takeHeldNativeChatNotes(sourceKey)))
  const editor = useNativeChatNotesEditor({ notes: initialNotes ?? held ?? [], offset })
  const [annotating, setAnnotating] = useState(Boolean(initialNotes?.length || held?.length))
  const [panelHidden, setPanelHidden] = useState(false)
  const [busy, setBusy] = useState(false)
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_WIDTH)
  const [loaded, setLoaded] = useState<{ size: PanZoomSize; image: HTMLImageElement } | null>(null)
  const panZoom = usePanZoomViewport({ content: loaded?.size ?? null, contain: true })
  const { setCanvas, canvasHandlers, cursor, scale, offset: viewOffset } = panZoom
  const layerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < NARROW_WIDTH)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  // Phones view sent notes; making notes needs a pointer and a keyboard.
  const canAnnotate =
    annotatable && Boolean(loaded) && !window.matchMedia('(pointer: coarse)').matches
  const { notes } = editor
  // The message box lives outside the viewer: looked up once the viewer and its image are on screen.
  const [composer, setComposer] = useState<NativeChatNotesComposer | null>(null)
  useLayoutEffect(() => setComposer(nativeChatNotesComposer(opener.current)), [opener, loaded])
  const admitted = composer?.handle.notesAdmitted?.() ?? false
  const sendReason = editor.hasUnadded
    ? t('components.native-chat.notes.addFirst', 'Add or discard note {{number}} first', {
        number: editor.pending?.number ?? editor.editing?.number ?? 0
      })
    : !admitted
      ? t(
          'components.native-chat.notes.commandHeld',
          'Your message box holds a command. Send or clear it first.'
        )
      : null
  const canSend = notes.length > 0 && !editor.hasUnadded && admitted && !busy && Boolean(composer)
  const focusMedia = (): void => layerRef.current?.focus({ preventScroll: true })
  // Stepping away would drop notes in progress, so it waits until there are none.
  const stepping = !annotating && notes.length === 0
  const step =
    onPrevious === undefined && onNext === undefined
      ? null
      : {
          previous: stepping ? (onPrevious ?? null) : null,
          next: stepping ? (onNext ?? null) : null
        }

  const handOff = useCallback(
    async (send: boolean): Promise<boolean> => {
      if (!composer || !loaded || notes.length === 0) {
        return false
      }
      setBusy(true)
      let handed = false
      try {
        const ids = await attachNativeChatNotes({
          composer,
          mediaName: title,
          kind: 'image',
          source,
          notes,
          offset,
          frame: async () => ({ image: loaded.image, ...loaded.size })
        })
        onAttached?.(ids)
        handed = true
        if (send) {
          await afterComposerRender()
          composer.handle.submit?.()
          setBusy(false)
          return true
        }
        const count = notes.length
        // Undo stays live only while those images are still in the draft.
        const toastId = toast(
          t(
            'components.native-chat.notes.addedToMessage',
            '{{count}} notes added to your message',
            { defaultValue_one: '{{count}} note added to your message', count }
          ),
          {
            action: {
              label: t('components.native-chat.notes.undo', 'Undo'),
              onClick: () => {
                if (nativeChatNotesStillInDraft(composer.scopeKey, ids)) {
                  detachNativeChatNotes(composer.scopeKey, ids)
                  holdNativeChatNotes(sourceKey, notes)
                }
              }
            }
          }
        )
        watchNativeChatNotesLeaveDraft(composer.scopeKey, ids, () => toast.dismiss(toastId))
      } catch (error) {
        editor.setStatus({
          kind: 'error',
          message: t(
            'components.native-chat.notes.prepareFailed',
            'Couldn’t prepare the marked image. Your notes are still here.'
          )
        })
        console.error('[native-chat] notes hand-off failed', error)
      }
      setBusy(false)
      return handed
    },
    [composer, editor, loaded, notes, offset, onAttached, source, sourceKey, t, title]
  )

  const close = async (): Promise<void> => {
    if (editor.hasUnadded) {
      setPanelHidden(false)
      editor.setConfirm({ reason: 'close' })
      return
    }
    if (notes.length > 0 && !initialNotes) {
      if (!admitted) {
        // A command waits in the message box: the notes stay with this image for later.
        holdNativeChatNotes(sourceKey, notes)
        toast(
          t(
            'components.native-chat.notes.keptWithImage',
            'Notes kept with {{name}}. Your message box holds a command.',
            { name: title }
          )
        )
      } else if (!(await handOff(false))) {
        return
      }
    } else if (notes.length > 0 && initialNotes && !(await handOff(false))) {
      return
    }
    onOpenChange(false)
  }
  const send = async (): Promise<void> => {
    if (canSend && (await handOff(true))) {
      onOpenChange(false)
    }
  }
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
      surface="media"
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
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          void send()
        } else if (!typing && event.key.toLowerCase() === 'z' && (event.metaKey || event.ctrlKey)) {
          if (editor.undo()) {
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
            requestAnimationFrame(focusMedia)
          }
        } else if (!typing && step && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
          const go = event.key === 'ArrowLeft' ? step.previous : step.next
          if (go && !event.altKey && !event.metaKey && !event.ctrlKey) {
            event.preventDefault()
            go()
          }
        } else if (!typing && event.key === 'C' && event.shiftKey && annotating) {
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
        onAnnotate={() =>
          annotating ? finishAnnotating() : (setAnnotating(true), requestAnimationFrame(focusMedia))
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
          ref={setCanvas}
          {...canvasHandlers}
          className={cn(
            'relative size-full touch-none overflow-hidden',
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
                className="pointer-events-none size-full select-none rounded-[3px]"
              />
              <div ref={layerRef} className="absolute inset-0">
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
          {src && !loaded ? <NativeChatMediaImageLoader src={src} onLoaded={setLoaded} /> : null}
          {!src ? (
            <div className="flex size-full items-center justify-center">{fallback}</div>
          ) : null}
        </div>
      </div>
      {!(narrow && annotating && !panelHidden) ? (
        <NativeChatMediaViewerZoom panZoom={panZoom} />
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
                void close()
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
