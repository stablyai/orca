import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { translate } from '@/i18n/i18n'
import type { useComposerState } from '@/hooks/useComposerState'
import {
  formatWorkspaceCreateError,
  getWorkspaceCreateErrorToastMessage
} from '@/lib/workspace/creation/workspace-create-error-format'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { ComposerModalData } from './composer-modal-data'
import { recordSingleProjectCreate } from './multi-repo-last-set-storage'
import { useMultiRepoComposer } from './use-multi-repo-composer'

type CardProps = ReturnType<typeof useComposerState>['cardProps']
type QuickAgentPick = Omit<NonNullable<ComposerModalData['recovery']>, 'note'>

/** Reopens the composer with the user's inputs when quick create cannot prepare the legacy launch. */
export function toastReopenComposerAfterLegacyFailure(
  error: unknown,
  context: {
    modalData: ComposerModalData
    cardProps: CardProps
    quickAgentPick: QuickAgentPick
    quickAgent: TuiAgent | null
    isSubmissionCancelled: () => boolean
  }
): void {
  const { modalData, cardProps, quickAgentPick, quickAgent, isSubmissionCancelled } = context
  if (isSubmissionCancelled()) {
    return
  }
  const snapshot = {
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
    recovery: { ...quickAgentPick, agent: quickAgent, note: cardProps.note }
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

/** Read at create time so the remembered-set counter sees the project that was actually submitted. */
export function useSingleProjectCreateRecorder(onClose: () => void): {
  projectIdRef: React.MutableRefObject<string | null>
  onCreated: () => void
} {
  const projectIdRef = useRef<string | null>(null)
  const onCreated = useCallback(() => {
    recordSingleProjectCreate(projectIdRef.current)
    onClose()
  }, [onClose])
  return { projectIdRef, onCreated }
}

export function useQuickMultiRepo(args: {
  cardProps: CardProps
  projectIdRef: React.MutableRefObject<string | null>
  quickAgent: TuiAgent | null
  onClose: () => void
  isSubmissionCancelled: () => boolean
  singleCreateDisabled: boolean
  launchReady: boolean
}): { multiRepo: ReturnType<typeof useMultiRepoComposer>; createDisabled: boolean } {
  const { cardProps, projectIdRef, quickAgent, onClose, isSubmissionCancelled } = args
  useEffect(() => {
    projectIdRef.current = cardProps.selectedRepoProjectId ?? null
  }, [cardProps.selectedRepoProjectId, projectIdRef])
  const multiRepo = useMultiRepoComposer({
    primaryProjectId: cardProps.selectedRepoProjectId ?? null,
    projectOptions: cardProps.projectOptions ?? [],
    projectHostSetupOptions: cardProps.projectHostSetupOptions ?? [],
    hostId: cardProps.selectedRepoExecutionHostId ?? null,
    name: cardProps.name,
    quickAgent,
    onPrimaryProjectChange: cardProps.onProjectChange,
    onProjectHostSetupChange: cardProps.onProjectHostSetupChange,
    onCreated: onClose,
    isSubmissionCancelled
  })
  const createDisabled = multiRepo.active
    ? multiRepo.creating ||
      multiRepo.blockedCount > 0 ||
      multiRepo.supported === false ||
      cardProps.name.trim() === '' ||
      !args.launchReady
    : args.singleCreateDisabled
  return { multiRepo, createDisabled }
}
