import { useSyncExternalStore } from 'react'

let deleteModifierPressed = false
let listenersInstalled = false
const listeners = new Set<() => void>()

function notifyListeners(): void {
  for (const listener of listeners) {
    listener()
  }
}

function setDeleteModifierPressed(next: boolean): void {
  if (deleteModifierPressed === next) {
    return
  }
  deleteModifierPressed = next
  notifyListeners()
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.altKey || event.key === 'Alt') {
    setDeleteModifierPressed(true)
  }
}

function onKeyUp(event: KeyboardEvent): void {
  if (event.key === 'Alt' || !event.altKey) {
    setDeleteModifierPressed(false)
  }
}

function clearDeleteModifierPressed(): void {
  setDeleteModifierPressed(false)
}

function installListeners(): void {
  if (listenersInstalled || typeof window === 'undefined') {
    return
  }
  listenersInstalled = true
  // Why: Option/Alt is a transient reveal modifier, so stale key state after
  // focus loss would leave destructive affordances visible.
  window.addEventListener('keydown', onKeyDown, { capture: true })
  window.addEventListener('keyup', onKeyUp, { capture: true })
  window.addEventListener('blur', clearDeleteModifierPressed)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', clearDeleteModifierPressed)
  }
}

function uninstallListeners(): void {
  if (!listenersInstalled || typeof window === 'undefined') {
    return
  }
  listenersInstalled = false
  window.removeEventListener('keydown', onKeyDown, { capture: true })
  window.removeEventListener('keyup', onKeyUp, { capture: true })
  window.removeEventListener('blur', clearDeleteModifierPressed)
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', clearDeleteModifierPressed)
  }
  clearDeleteModifierPressed()
}

function subscribeDeleteModifier(listener: () => void): () => void {
  listeners.add(listener)
  installListeners()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      uninstallListeners()
    }
  }
}

function getDeleteModifierSnapshot(): boolean {
  return deleteModifierPressed
}

function getServerDeleteModifierSnapshot(): boolean {
  return false
}

export function useWorkspaceDeleteModifierPressed(): boolean {
  return useSyncExternalStore(
    subscribeDeleteModifier,
    getDeleteModifierSnapshot,
    getServerDeleteModifierSnapshot
  )
}

export function canShowWorkspaceDeleteQuickAction(args: {
  deleteModifierPressed: boolean
  isDeleting: boolean
  isMainWorktree: boolean
}): boolean {
  return args.deleteModifierPressed && !args.isDeleting && !args.isMainWorktree
}
