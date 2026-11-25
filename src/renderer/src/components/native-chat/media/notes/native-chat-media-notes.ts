// Notes on an image or a video frame: a numbered pin or box in coordinates relative to the media,
// so zoom, pan and window size never move a mark.

import { GENERATED_NOTE_IMAGE_MAX_EDGE } from '../../../../../../shared/native-chat/media-notes/generated-note-image'

export type NativeChatNoteMark =
  | { kind: 'pin'; x: number; y: number }
  | { kind: 'box'; x: number; y: number; width: number; height: number }

export type NativeChatMediaNote = {
  id: string
  /** 1-based; continues after marks already drawn into a sent copy. */
  number: number
  text: string
  mark: NativeChatNoteMark
  /** Seconds into a video; absent for an image. */
  time?: number
}

/** Outputs are drawn at most this long on their long edge, the size agents read images at. */
export const NATIVE_CHAT_NOTE_IMAGE_MAX_EDGE = GENERATED_NOTE_IMAGE_MAX_EDGE
/** Characters one note may hold; the note editor stops taking text here. */
export const NATIVE_CHAT_NOTE_TEXT_MAX = 2000
/** Distinct video frames one message may carry. */
export const NATIVE_CHAT_NOTE_MAX_FRAMES = 8

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

/** A box from two corners in either order; a drag shorter than `minSize` (relative) is a pin. */
export function nativeChatNoteMarkFromDrag(
  start: { x: number; y: number },
  end: { x: number; y: number },
  minSize = 0.01
): NativeChatNoteMark {
  const x = clamp01(Math.min(start.x, end.x))
  const y = clamp01(Math.min(start.y, end.y))
  const width = clamp01(Math.max(start.x, end.x)) - x
  const height = clamp01(Math.max(start.y, end.y)) - y
  if (width < minSize && height < minSize) {
    return { kind: 'pin', x: clamp01(start.x), y: clamp01(start.y) }
  }
  return { kind: 'box', x, y, width, height }
}

/** Moves a mark by a relative step, keeping it on the media. */
export function moveNativeChatNoteMark(
  mark: NativeChatNoteMark,
  dx: number,
  dy: number
): NativeChatNoteMark {
  if (mark.kind === 'pin') {
    return { kind: 'pin', x: clamp01(mark.x + dx), y: clamp01(mark.y + dy) }
  }
  return {
    ...mark,
    x: Math.min(1 - mark.width, Math.max(0, mark.x + dx)),
    y: Math.min(1 - mark.height, Math.max(0, mark.y + dy))
  }
}

/** Numbers notes 1…n after `offset` in their current order. */
export function renumberNativeChatNotes<T extends NativeChatMediaNote>(
  notes: readonly T[],
  offset = 0
): T[] {
  return notes.map((note, index) => ({ ...note, number: offset + index + 1 }))
}

const sameTime = (a: number | undefined, b: number | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && Math.abs(a - b) < 0.02)

/** Notes grouped by video frame (images have one group), in first-note order. */
export function groupNativeChatNotesByFrame<T extends NativeChatMediaNote>(
  notes: readonly T[]
): T[][] {
  const groups: T[][] = []
  for (const note of notes) {
    const group = groups.find((candidate) => sameTime(candidate[0]?.time, note.time))
    if (group) {
      group.push(note)
    } else {
      groups.push([note])
    }
  }
  return groups
}

/** "0:02", or "0:02.4" when another noted frame falls in the same second. */
export function formatNativeChatNoteTime(time: number, precise: boolean): string {
  const whole = Math.floor(time + 1e-6)
  const minutes = Math.floor(whole / 60)
  const seconds = String(whole % 60).padStart(2, '0')
  const tenths = precise ? `.${Math.floor((time - whole) * 10 + 1e-6)}` : ''
  return `${minutes}:${seconds}${tenths}`
}

/** Whether two noted frames share a whole second, so their times need tenths to differ. */
export function nativeChatNoteTimesNeedTenths(notes: readonly NativeChatMediaNote[]): boolean {
  const frames = groupNativeChatNotesByFrame(notes).map((group) => group[0]?.time)
  const seconds = frames.flatMap((time) => (time === undefined ? [] : [Math.floor(time + 1e-6)]))
  return new Set(seconds).size < seconds.length
}

/** The words the agent receives with a marked image: which media, which frame, and each note. */
export function nativeChatNotesText(
  mediaName: string,
  notes: readonly NativeChatMediaNote[],
  precise: boolean
): string {
  const time = notes[0]?.time
  const where =
    time === undefined ? mediaName : `${mediaName} at ${formatNativeChatNoteTime(time, precise)}`
  const lines = notes.map((note) => `${note.number}. ${note.text.trim().replace(/\r?\n/g, ' ')}`)
  return [`Notes on ${where} (numbered marks in the attached image):`, ...lines].join('\n')
}

/** The marked image's file name: the media's name, its frame time if any, and "-notes". */
const SENT_NOTES_HEAD = /^Notes on .+ \(numbered marks in the attached image\):$/

/** The highest note number already drawn into the marked images of a sent message, read from the
 *  notes text it carries, so new notes on one of those images continue after it. */
export function nativeChatSentNotesNumberMax(text: string): number {
  let max = 0
  let inNotes = false
  for (const line of text.split(/\r?\n/)) {
    if (SENT_NOTES_HEAD.test(line)) {
      inNotes = true
      continue
    }
    const numbered = inNotes ? /^(\d+)\. /.exec(line) : null
    if (numbered) {
      max = Math.max(max, Number(numbered[1]))
    } else {
      inNotes = false
    }
  }
  return max
}

/** `dashboard.png` gives `dashboard-notes.png`; notes on that copy give `dashboard-notes-2.png`, then
 *  `-3`, so a copy of a copy never reads `-notes-notes`. */
export function nativeChatNotesImageName(mediaName: string, time: number | undefined): string {
  const stem = mediaName.replace(/\.[^.]+$/, '')
  const marked = /^(.+)-notes(?:-(\d+))?$/.exec(stem)
  const base = marked ? marked[1] : stem
  const generation = marked ? Number(marked[2] ?? 1) + 1 : 1
  const frame = time === undefined ? '' : `-${time.toFixed(2).replace('.', '_')}s`
  return `${base}${frame}-notes${generation > 1 ? `-${generation}` : ''}.png`
}

/** Output size within the edge limit, keeping the aspect ratio. */
export function nativeChatNoteImageSize(
  width: number,
  height: number
): {
  width: number
  height: number
} {
  const scale = Math.min(1, NATIVE_CHAT_NOTE_IMAGE_MAX_EDGE / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}
