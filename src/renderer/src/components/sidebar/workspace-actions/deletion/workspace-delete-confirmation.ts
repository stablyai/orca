import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'

export const WORKSPACE_DELETE_CONFIRM_TIMEOUT_MS = 4000

export type WorkspaceDeleteConfirmationDependencies = {
  watchActiveWorkspace: (onChange: () => void) => () => void
  timeoutMs: number
}

// Why: transient per-row UI state, same module-store shape as workspace-delete-quick-action.ts.
let armedIdentity: string | null = null
let teardown: (() => void) | null = null
const listeners = new Set<() => void>()

function setArmedIdentity(next: string | null): void {
  if (armedIdentity === next) {
    return
  }
  armedIdentity = next
  for (const listener of listeners) {
    listener()
  }
}

const defaultDependencies: WorkspaceDeleteConfirmationDependencies = {
  timeoutMs: WORKSPACE_DELETE_CONFIRM_TIMEOUT_MS,
  watchActiveWorkspace: (onChange) =>
    useAppStore.subscribe((state, previous) => {
      if (
        state.activeWorktreeId !== previous.activeWorktreeId ||
        state.activeWorkspaceExecutionHostId !== previous.activeWorkspaceExecutionHostId
      ) {
        onChange()
      }
    })
}

export function cancelWorkspaceDeleteConfirmation(): void {
  teardown?.()
  teardown = null
  setArmedIdentity(null)
}

export function armWorkspaceDeleteConfirmation(
  identity: string,
  dependencies: WorkspaceDeleteConfirmationDependencies = defaultDependencies
): void {
  cancelWorkspaceDeleteConfirmation()
  const timer = setTimeout(cancelWorkspaceDeleteConfirmation, dependencies.timeoutMs)
  const unwatch = dependencies.watchActiveWorkspace(cancelWorkspaceDeleteConfirmation)
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      cancelWorkspaceDeleteConfirmation()
    }
  }
  // Why: capture so Escape cancels even while a terminal owns focus; not consumed.
  window.addEventListener('keydown', onKeyDown, { capture: true })
  teardown = () => {
    clearTimeout(timer)
    unwatch()
    window.removeEventListener('keydown', onKeyDown, { capture: true })
  }
  setArmedIdentity(identity)
}

/** True (and disarmed) only when `identity` is the armed workspace. */
export function confirmWorkspaceDeleteConfirmation(identity: string): boolean {
  if (armedIdentity !== identity) {
    return false
  }
  cancelWorkspaceDeleteConfirmation()
  return true
}

export function getArmedWorkspaceDeleteIdentity(): string | null {
  return armedIdentity
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useWorkspaceDeleteConfirmationArmed(identity: string): boolean {
  return (
    useSyncExternalStore(
      subscribe,
      getArmedWorkspaceDeleteIdentity,
      getArmedWorkspaceDeleteIdentity
    ) === identity
  )
}
