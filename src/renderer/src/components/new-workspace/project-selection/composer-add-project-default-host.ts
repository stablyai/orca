import type { ProjectHostSetupOption } from '@/lib/workspace/creation/project-host-setup-options'
import type { ExecutionHostId } from '../../../../../shared/execution-host'

/** Sync the Add project menu's initial host with the composer's active Run on host selection. */
export function resolveComposerAddProjectDefaultHostId({
  projectHostSetupOptions,
  selectedProjectHostSetupId,
  selectedRepoExecutionHostId,
  selectedEphemeralVmRecipeId
}: {
  projectHostSetupOptions?: readonly ProjectHostSetupOption[]
  selectedProjectHostSetupId?: string | null
  selectedRepoExecutionHostId?: ExecutionHostId | null
  selectedEphemeralVmRecipeId?: string | null
}): ExecutionHostId | null {
  if (!selectedEphemeralVmRecipeId && projectHostSetupOptions && selectedProjectHostSetupId) {
    const isSelected = (candidate: { id: string; hostId: ExecutionHostId }): boolean =>
      candidate.id === selectedProjectHostSetupId &&
      (!selectedRepoExecutionHostId || candidate.hostId === selectedRepoExecutionHostId)
    const readyOptions = projectHostSetupOptions.filter((option) => option.kind === 'ready')
    const matched =
      readyOptions.find(isSelected) ??
      readyOptions.find((option) => option.aliasSetups?.some(isSelected)) ??
      projectHostSetupOptions.find((option) => option.id === selectedProjectHostSetupId)
    if (matched) {
      return matched.hostId
    }
  }
  return selectedRepoExecutionHostId ?? null
}
