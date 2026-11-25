import { useRef, useState } from 'react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import {
  moveNativeChatNoteMark,
  nativeChatNoteMarkFromDrag,
  type NativeChatMediaNote,
  type NativeChatNoteMark
} from './native-chat-media-notes'

type Point = { x: number; y: number }

// Fixed blue that also marks the image the agent receives, so it reads the same in both themes.
const BADGE =
  'flex size-5 items-center justify-center rounded-full border-2 border-media-note-foreground bg-media-note text-2xs font-semibold text-media-note-foreground ring-1 ring-media-canvas'
// Two-tone ring: dark edge and light halo, visible on light and dark media alike.
const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-media-canvas focus-visible:outline-offset-1 focus-visible:ring-4 focus-visible:ring-media-note-ring'

/** Numbered pins and boxes over the media, sized with it so zoom never moves a mark or scales its badge. */
export function NativeChatMediaMarks({
  notes,
  pending,
  selectedId,
  annotating,
  onPlace,
  onOpen,
  onMove
}: {
  notes: readonly NativeChatMediaNote[]
  pending: NativeChatMediaNote | null
  selectedId: string | null
  annotating: boolean
  onPlace: (mark: NativeChatNoteMark) => void
  onOpen: (id: string) => void
  onMove: (id: string, mark: NativeChatNoteMark) => void
}): React.JSX.Element {
  const layerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ start: Point; startPx: Point } | null>(null)
  const [ghost, setGhost] = useState<NativeChatNoteMark | null>(null)
  const relative = (event: { clientX: number; clientY: number }): Point => {
    const box = layerRef.current!.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height))
    }
  }
  const minDrag = (): number =>
    5 / Math.max(1, layerRef.current?.getBoundingClientRect().width ?? 1)
  const all = pending ? [...notes, pending] : notes
  return (
    <div
      ref={layerRef}
      data-native-chat-note-layer=""
      // Annotating, the media takes clicks and drags; pan stays on the wheel and Alt-drag. Keyboard
      // focus and Enter belong to the viewport around it.
      className={cn('absolute inset-0', annotating && 'cursor-crosshair')}
      onPointerDown={(event) => {
        // An Alt press is a pan: it goes on to the viewport rather than placing a mark.
        if (
          !annotating ||
          event.button !== 0 ||
          event.altKey ||
          event.target !== layerRef.current
        ) {
          return
        }
        event.stopPropagation()
        event.currentTarget.setPointerCapture(event.pointerId)
        dragRef.current = {
          start: relative(event),
          startPx: { x: event.clientX, y: event.clientY }
        }
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current
        if (!drag) {
          return
        }
        event.stopPropagation()
        if (Math.hypot(event.clientX - drag.startPx.x, event.clientY - drag.startPx.y) >= 5) {
          setGhost(nativeChatNoteMarkFromDrag(drag.start, relative(event), minDrag()))
        }
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current
        if (!drag) {
          return
        }
        event.stopPropagation()
        dragRef.current = null
        setGhost(null)
        onPlace(nativeChatNoteMarkFromDrag(drag.start, relative(event), minDrag()))
      }}
      onPointerCancel={() => {
        dragRef.current = null
        setGhost(null)
      }}
    >
      {all.map((note) => (
        <NoteMark
          key={note.id}
          note={note}
          unadded={note === pending}
          selected={note.id === selectedId}
          onOpen={() => onOpen(note.id)}
          onMove={(dx, dy) => onMove(note.id, moveNativeChatNoteMark(note.mark, dx, dy))}
        />
      ))}
      {ghost?.kind === 'box' ? (
        <div
          aria-hidden
          className="pointer-events-none absolute border-2 border-dashed border-media-note-ring bg-media-note/10"
          style={boxStyle(ghost)}
        />
      ) : null}
    </div>
  )
}

function boxStyle(mark: Extract<NativeChatNoteMark, { kind: 'box' }>): React.CSSProperties {
  return {
    left: `${mark.x * 100}%`,
    top: `${mark.y * 100}%`,
    width: `${mark.width * 100}%`,
    height: `${mark.height * 100}%`
  }
}

function NoteMark({
  note,
  unadded,
  selected,
  onOpen,
  onMove
}: {
  note: NativeChatMediaNote
  unadded: boolean
  selected: boolean
  onOpen: () => void
  onMove: (dx: number, dy: number) => void
}): React.JSX.Element {
  const t = useTranslate()
  const label = unadded
    ? t('components.native-chat.notes.markUnadded', 'Note {{number}}, not added yet', {
        number: note.number
      })
    : t('components.native-chat.notes.markLabel', 'Note {{number}}: {{text}}', {
        number: note.number,
        text: note.text
      })
  const common = {
    type: 'button' as const,
    'aria-label': label,
    title: label,
    onPointerDown: (event: React.PointerEvent) => event.stopPropagation(),
    onClick: (event: React.MouseEvent) => {
      event.stopPropagation()
      onOpen()
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      const step = event.shiftKey ? 0.1 : 0.01
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step]
      }
      const move = moves[event.key]
      if (move) {
        event.preventDefault()
        event.stopPropagation()
        onMove(...move)
      }
    }
  }
  const ring = selected
    ? 'outline-2 outline-media-canvas outline-offset-1 ring-4 ring-media-note-selected'
    : ''
  if (note.mark.kind === 'box') {
    return (
      <button
        {...common}
        className={cn(
          'absolute rounded-xs border-2 border-media-note bg-media-note/15 ring-1 ring-inset ring-media-note-foreground',
          ring,
          FOCUS_RING
        )}
        style={boxStyle(note.mark)}
      >
        <span aria-hidden className={cn(BADGE, 'absolute -top-2.5 -left-2.5')}>
          {note.number}
        </span>
      </button>
    )
  }
  return (
    <button
      {...common}
      // The badge sits above-right of the point it marks, so it never hides what it points at.
      className={cn(
        BADGE,
        'absolute -mt-6 ml-0.5 rounded-br-full rounded-bl-[3px]',
        ring,
        FOCUS_RING
      )}
      style={{ left: `${note.mark.x * 100}%`, top: `${note.mark.y * 100}%` }}
    >
      {note.number}
    </button>
  )
}
