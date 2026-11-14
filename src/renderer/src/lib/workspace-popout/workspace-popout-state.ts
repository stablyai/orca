import { useSyncExternalStore } from 'react'
import type {
  WorkspacePopoutStateChanged,
  WorkspacePopoutTarget
} from '../../../../shared/workspace-popout/workspace-popout-contract'

// Map worktreeId -> tabId
const poppedOutTabsByWorktree = new Map<string, string>()
const changeListeners = new Set<() => void>()

function notifyListeners(): void {
  for (const listener of changeListeners) {
    listener()
  }
}

export function subscribePopoutChanges(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

export function isTabPoppedOut(tabId: string): boolean {
  for (const tId of poppedOutTabsByWorktree.values()) {
    if (tId === tabId) {
      return true
    }
  }
  return false
}

export function getPoppedOutTabId(worktreeId: string): string | null {
  return poppedOutTabsByWorktree.get(worktreeId) ?? null
}

export function setPopoutState(worktreeId: string, tabId: string, open: boolean): void {
  if (open) {
    poppedOutTabsByWorktree.set(worktreeId, tabId)
  } else {
    poppedOutTabsByWorktree.delete(worktreeId)
  }
  notifyListeners()
}

let initialized = false

export function initWorkspacePopoutState(): () => void {
  if (typeof window === 'undefined' || !window.api?.workspacePopout) {
    return () => undefined
  }

  if (!initialized) {
    initialized = true
    void window.api.workspacePopout.list().then((list) => {
      let changed = false
      for (const entry of list) {
        if (entry.state === 'open' || entry.state === 'opening' || entry.state === 'recovering') {
          poppedOutTabsByWorktree.set(entry.worktreeId, entry.tabId)
          changed = true
        }
      }
      if (changed) {
        notifyListeners()
      }
    })
  }

  const off = window.api.workspacePopout.onStateChanged((change: WorkspacePopoutStateChanged) => {
    if (change.open) {
      setPopoutState(change.worktreeId, change.tabId, true)
    } else {
      setPopoutState(change.worktreeId, change.tabId, false)
    }
  })

  return off
}

export function useIsTabPoppedOut(tabId: string | undefined): boolean {
  return useSyncExternalStore(
    subscribePopoutChanges,
    () => (tabId ? isTabPoppedOut(tabId) : false),
    () => false
  )
}

export function useWorktreePopout(worktreeId: string | undefined): string | null {
  return useSyncExternalStore(
    subscribePopoutChanges,
    () => (worktreeId ? getPoppedOutTabId(worktreeId) : null),
    () => null
  )
}

export async function popOutTerminalTab(target: WorkspacePopoutTarget): Promise<void> {
  if (!window.api?.workspacePopout) {
    return
  }
  await window.api.workspacePopout.open(target)
}

export async function dockTerminalTab(worktreeId: string): Promise<void> {
  if (!window.api?.workspacePopout) {
    return
  }
  await window.api.workspacePopout.dock(worktreeId)
}

export async function focusTerminalTab(worktreeId: string): Promise<void> {
  if (!window.api?.workspacePopout) {
    return
  }
  await window.api.workspacePopout.focus(worktreeId)
}
