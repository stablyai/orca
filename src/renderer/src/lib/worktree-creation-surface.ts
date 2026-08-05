import type { UISlice } from '@/store/slices/ui'

export type WorktreeCreationSurfaceInput = {
  activeView: UISlice['activeView']
  activePendingCreationId: string | null
  hasActivePendingCreation: boolean
}

export function shouldShowWorktreeCreationSurface({
  activeView,
  activePendingCreationId,
  hasActivePendingCreation
}: WorktreeCreationSurfaceInput): boolean {
  return activeView === 'terminal' && activePendingCreationId !== null && hasActivePendingCreation
}

export type TerminalWorkbenchVisibilityInput = WorktreeCreationSurfaceInput & {
  activeWorktreeId: string | null
}

// Why: App renders the workbench with `hidden` instead of unmounting it, so a mounted pane
// must consult this before anchoring a portaled layer to its own toolbar.
export function isTerminalWorkbenchVisible(input: TerminalWorkbenchVisibilityInput): boolean {
  return (
    input.activeView === 'terminal' &&
    input.activeWorktreeId !== null &&
    !shouldShowWorktreeCreationSurface(input)
  )
}
