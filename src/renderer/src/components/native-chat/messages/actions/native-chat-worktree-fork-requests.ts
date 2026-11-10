import { useEffect, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

// Menus outside a chat's pane (tab bar, sidebar) ask it to open its own fork dialog.
const pendingTabIds = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Opens the new-worktree fork dialog in this chat tab's pane once it is showing. */
export function requestNativeChatWorktreeFork(tabId: string): void {
  pendingTabIds.add(tabId)
  version += 1
  for (const listener of listeners) {
    listener()
  }
}

/** Hands this pane its pending request once it can fork; `openLatest` is absent until then. */
export function useNativeChatWorktreeForkRequest(
  tabId: string,
  openLatest: (() => boolean) | undefined
): void {
  const current = useSyncExternalStore(subscribe, () => version)
  useEffect(() => {
    if (!openLatest || !pendingTabIds.delete(tabId)) {
      return
    }
    if (!openLatest()) {
      toast.message(
        translate('components.native-chat.fork.commandNothing', 'There’s no response to fork yet.')
      )
    }
  }, [current, openLatest, tabId])
}
