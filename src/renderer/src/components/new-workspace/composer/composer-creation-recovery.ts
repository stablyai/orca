import { toast } from 'sonner'
import {
  formatWorkspaceCreateError,
  getWorkspaceCreateErrorToastMessage
} from '@/lib/workspace/creation/workspace-create-error-format'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import type { ComposerModalData } from './composer-modal-data'
import type { ComposerCardProps } from '@/hooks/useComposerState'

export function reportComposerPreparationFailure({
  error,
  modalData,
  cardProps,
  recovery,
  isSubmissionCancelled
}: {
  error: unknown
  modalData: ComposerModalData
  cardProps: ComposerCardProps
  recovery: NonNullable<ComposerModalData['recovery']>
  isSubmissionCancelled: () => boolean
}): void {
  if (isSubmissionCancelled()) {
    return
  }
  const snapshot: ComposerModalData = {
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
  toast.error(getWorkspaceCreateErrorToastMessage(formatWorkspaceCreateError(error)), {
    action: {
      label: translate('auto.lib.composerCreateHandoff.reopen', 'Reopen'),
      onClick: () => {
        if (!isSubmissionCancelled() && useAppStore.getState().activeModal === 'none') {
          useAppStore.getState().openModal('new-workspace-composer', snapshot)
        }
      }
    }
  })
}
