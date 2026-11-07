import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { useAppStore } from '@/store'

export function focusWorktreeCreateTriggerAfterDismissal(
  root: HTMLElement | null,
  worktreeId: string,
  executionHostId: ExecutionHostId
): (() => void) | undefined {
  const button = root?.querySelector('button')
  const ownerUnchanged = () => {
    const state = useAppStore.getState()
    return (
      state.activeWorktreeId === worktreeId &&
      state.activeWorkspaceExecutionHostId === executionHostId
    )
  }
  if (!button || !ownerUnchanged()) {
    return
  }
  let released = false
  const release = () => {
    if (released) {
      return
    }
    released = true
    button.removeAttribute('data-worktree-create-focus-recovery')
    unsubscribe()
    button.removeEventListener('blur', release)
    document.removeEventListener('keydown', release, true)
    document.removeEventListener('pointerdown', release, true)
  }
  const unsubscribe = useAppStore.subscribe(() => {
    if (!ownerUnchanged()) {
      release()
    }
  })
  button.setAttribute('data-worktree-create-focus-recovery', '')
  button.addEventListener('blur', release, { once: true })
  document.addEventListener('keydown', release, { once: true, capture: true })
  document.addEventListener('pointerdown', release, { once: true, capture: true })
  button.focus()
  return release
}
