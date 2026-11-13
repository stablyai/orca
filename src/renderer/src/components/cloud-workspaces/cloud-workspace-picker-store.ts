// "Open cloud workspace…": the one place to open a cloud workspace this computer's sidebar doesn't
// show (a teammate's shared one, one started on another computer, one whose pairing was removed).
// Every surface that used to send people to the Home list opens this instead, with a focus that
// says why: the running limit lists your running ones, a teammate's profile lists theirs.
import { useSyncExternalStore } from 'react'

export type CloudWorkspacePickerFocus =
  /** Anything not in this sidebar yet (the menu, the palette, a broken pairing). */
  | { kind: 'open' }
  /** Everything one teammate has that you can see (their profile's "Show all"). */
  | { kind: 'teammate'; userId: string }
  /** At the running-sandbox limit: your running ones, sidebar ones too, to put one to sleep. */
  | { kind: 'running' }
  /** Deleting the team: every team workspace, archived ones too, so they can be deleted first. */
  | { kind: 'team-cleanup' }

export type CloudWorkspacePickerRequest = { id: number; focus: CloudWorkspacePickerFocus }

let request: CloudWorkspacePickerRequest | null = null
let nextId = 0
const listeners = new Set<() => void>()

function emit(): void {
  listeners.forEach((listener) => listener())
}

export function openCloudWorkspacePicker(
  focus: CloudWorkspacePickerFocus = { kind: 'open' }
): void {
  // A new id each time: a second open (another focus) starts the picker over.
  request = { id: ++nextId, focus }
  emit()
}

export function closeCloudWorkspacePicker(): void {
  if (request) {
    request = null
    emit()
  }
}

export function getCloudWorkspacePickerRequest(): CloudWorkspacePickerRequest | null {
  return request
}

export function useCloudWorkspacePickerRequest(): CloudWorkspacePickerRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => request
  )
}
