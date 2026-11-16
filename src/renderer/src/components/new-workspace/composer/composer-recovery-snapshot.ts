import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { isModalSurfaceIdle } from '@/lib/workspace/creation/workspace-composer-pane-surface'
import {
  formatWorkspaceCreateError,
  getWorkspaceCreateErrorToastMessage
} from '@/lib/workspace/creation/workspace-create-error-format'
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

export function showComposerRecoveryError(
  error: unknown,
  snapshot: ComposerModalData,
  isSubmissionCancelled: () => boolean,
  restorePrompt?: () => void
): void {
  toast.error(getWorkspaceCreateErrorToastMessage(formatWorkspaceCreateError(error)), {
    action: {
      label: translate('auto.lib.composerCreateHandoff.reopen', 'Reopen'),
      onClick: () => {
        if (!isSubmissionCancelled() && isModalSurfaceIdle(useAppStore.getState())) {
          restorePrompt?.()
          useAppStore.getState().openModal('new-workspace-composer', snapshot)
        }
      }
    }
  })
}
