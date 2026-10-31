import { create } from 'zustand'

// Navigation is window-local; the session and its ordinary host tab own durable identity.
export type ThreadSelection =
  | { kind: 'new'; projectKey: string; draftId: string }
  | { kind: 'thread'; tabId: string }
export const useThreadNavigation = create<{ selection: ThreadSelection | null }>(() => ({
  selection: null
}))
export function clearThreadSelection(): void {
  if (useThreadNavigation.getState().selection) {
    useThreadNavigation.setState({ selection: null })
  }
}
