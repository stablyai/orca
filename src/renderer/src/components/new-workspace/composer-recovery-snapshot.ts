import type { ComposerCardProps } from '@/hooks/useComposerState'
import type { ComposerModalData } from './composer/composer-modal-data'

export function composerRecoverySnapshot(
  modalData: ComposerModalData,
  card: ComposerCardProps,
  recovery: ComposerModalData['recovery']
): ComposerModalData {
  return {
    ...modalData,
    prefilledName: card.name,
    initialRepoId: card.repoId,
    initialBaseBranch: card.baseBranch,
    initialWorkspaceTarget:
      card.selectedProjectId && card.selectedRepoExecutionHostId
        ? {
            projectId: card.selectedProjectId,
            hostId: card.selectedRepoExecutionHostId,
            projectHostSetupId: card.selectedProjectHostSetupId ?? null
          }
        : modalData.initialWorkspaceTarget,
    linkedWorkItem: card.linkedWorkItem,
    recovery
  }
}
