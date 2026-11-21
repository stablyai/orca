import { useSyncExternalStore } from 'react'

/** A video a chat link asked to open in the notes viewer. */
export type NativeChatVideoNotesRequest = {
  path: string
  title: string
  /** The link: it finds the chat (and its message box), and gets focus back on close. */
  opener: HTMLElement
  /** The editor tab the link would have opened. */
  openInEditor: () => void
}

let current: NativeChatVideoNotesRequest | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** Opens `request` in its chat's notes viewer. */
export function openNativeChatVideoNotes(request: NativeChatVideoNotesRequest): void {
  current = request
  emit()
}

export function closeNativeChatVideoNotes(request: NativeChatVideoNotesRequest): void {
  if (current === request) {
    current = null
    emit()
  }
}

/** The open request, for the chat whose root holds its link; null for every other chat. */
export function useNativeChatVideoNotesRequest(
  root: React.RefObject<HTMLElement | null>
): NativeChatVideoNotesRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => (current && root.current?.contains(current.opener) ? current : null)
  )
}
