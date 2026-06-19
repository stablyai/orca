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
