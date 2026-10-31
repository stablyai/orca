import { create } from 'zustand'
import type { AppState } from '@/store/types'

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

export function activeThreadSelection(
  state: Pick<AppState, 'settings' | 'activeView'>
): ThreadSelection | null {
  return state.settings?.experimentalThreads && state.activeView === 'terminal'
    ? useThreadNavigation.getState().selection
    : null
}
