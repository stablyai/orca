import type { useComposerState } from '@/hooks/useComposerState'
import type { ComposerModalData } from './composer-modal-data'

/** What a "Reopen" after a failed preparation restores: the submitted form, not the original request. */
export function buildComposerRecoverySnapshot(
  modalData: ComposerModalData,
  cardProps: ReturnType<typeof useComposerState>['cardProps'],
  recovery: NonNullable<ComposerModalData['recovery']>
): ComposerModalData {
  return {
    ...modalData,
    prefilledName: cardProps.name,
    initialRepoId: cardProps.repoId,
    initialBaseBranch: cardProps.baseBranch,
    initialWorkspaceTarget:
      cardProps.selectedProjectId && cardProps.selectedRepoExecutionHostId
        ? {
            projectId: cardProps.selectedProjectId,
            hostId: cardProps.selectedRepoExecutionHostId,
            projectHostSetupId: cardProps.selectedProjectHostSetupId ?? null
          }
        : modalData.initialWorkspaceTarget,
    linkedWorkItem: cardProps.linkedWorkItem,
    recovery
  }
}
