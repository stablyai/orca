import type { NativeChatMediaNote } from './native-chat-media-notes'

// Notes a closed viewer could not hand to the message box (it held a command), kept with their
// media for this session so reopening it brings them back. Bounded: oldest media dropped first.
const HELD_MAX = 20
const held = new Map<string, readonly NativeChatMediaNote[]>()

export function holdNativeChatNotes(mediaKey: string, notes: readonly NativeChatMediaNote[]): void {
  held.delete(mediaKey)
  held.set(mediaKey, notes)
  while (held.size > HELD_MAX) {
    const oldest = held.keys().next().value
    if (oldest === undefined) {
      break
    }
    held.delete(oldest)
  }
}

/** The notes held for this media, removed from the hold as the viewer takes them back. */
export function takeHeldNativeChatNotes(mediaKey: string): readonly NativeChatMediaNote[] | null {
  const notes = held.get(mediaKey) ?? null
  held.delete(mediaKey)
  return notes
}
