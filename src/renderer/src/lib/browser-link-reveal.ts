import type { AppState } from '@/store/types'
import { captureWorkspaceSelection, isWorkspaceSelected } from './active-workspace-host'

type SelectionState = Partial<
  Pick<AppState, 'activeView' | 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'>
>

export type BrowserLinkSelectionSubscriber = (
  listener: (state: SelectionState) => void
) => () => void

/** Navigation relinquishes foreground ownership even if the user later returns. */
export function captureBrowserLinkReveal(
  getState: () => SelectionState,
  subscribe?: BrowserLinkSelectionSubscriber,
  canReveal?: () => boolean
): { canReveal: () => boolean; dispose: () => void } {
  const initial = getState()
  const selection = captureWorkspaceSelection(initial)
  const activeView = initial.activeView
  let ownsSelection = true
  const observe = (state: SelectionState): boolean => {
    ownsSelection &&= isWorkspaceSelected(state, selection) && state.activeView === activeView
    return ownsSelection
  }
  const dispose = subscribe?.(observe) ?? (() => {})
  return { canReveal: () => observe(getState()) && canReveal?.() !== false, dispose }
}
