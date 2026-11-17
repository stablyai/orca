// The composer modal's side of Orca Cloud: feeds the composer state into useCloudStartComposer and
// returns what the primary button and ⌘↵ do.
import { useCallback, useEffect, useMemo, type MutableRefObject } from 'react'
import { useNeedsRepoSubmitGuard } from './use-needs-repo-submit-guard'
import type { ComposerModalData } from '../composer/composer-modal-data'
import type { NewWorkspaceComposerCardProps } from '../composer/new-workspace-composer-card-props'
import { useCloudStartComposer } from './use-cloud-start-composer'
import type { CloudFirstAgentLaunch } from '@/lib/orca-cloud/github-create-source'
import type { AgentLaunchChoice } from '@/lib/agent-session/launch/routing/agent-menu-selection'
import { quickWorkspacePickerInputs } from '@/lib/workspace/creation/quick-workspace-agent-selection'
import type { AgentPickerDraft } from '../../../../../shared/agent-launch/picker/agent-launch-picker'
import { buildComposerSnapshot } from '../composer-cloud-auto-start'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'

type ComposerCardState = Pick<
  NewWorkspaceComposerCardProps,
  | 'orcaCloudAvailability'
  | 'selectedEphemeralVmRecipeId'
  | 'onEphemeralVmRecipeChange'
  | 'repoId'
  | 'name'
  | 'baseBranch'
  | 'note'
> & { linkedWorkItem?: ComposerModalData['linkedWorkItem'] }

export function useComposerCloudStart({
  active,
  modalData,
  cardProps,
  quickAgent,
  launchChoice,
  pickerDraft,
  handleCreate,
  createDisabled,
  quickAgentPick,
  recordCreatedRef,
  onClose
}: {
  active: boolean
  modalData: ComposerModalData
  cardProps: ComposerCardState
  quickAgent: TuiAgent | null
  /** The agent's chat-or-terminal pick and its setup: a start straight from GitHub launches it. */
  launchChoice?: AgentLaunchChoice
  pickerDraft?: AgentPickerDraft
  handleCreate: () => Promise<void>
  createDisabled: boolean
  /** The agent pick (surface, draft) as the composer keeps it, for the setup page's snapshot. */
  quickAgentPick: Omit<NonNullable<ComposerModalData['recovery']>, 'note'>
  /** The composer's onCreated calls this: only a start that happened is remembered. */
  recordCreatedRef: MutableRefObject<(() => void) | null>
  onClose?: () => void
}) {
  const requestedSurface = launchChoice?.requestedSurface
  const firstAgent = useMemo<CloudFirstAgentLaunch>(
    () => ({
      ...quickWorkspacePickerInputs(pickerDraft, quickAgentPick.entry, undefined).launchInputs,
      ...(requestedSurface ? { requestedSurface } : {})
    }),
    [pickerDraft, quickAgentPick.entry, requestedSurface]
  )
  // The latest handleCreate, never a ref copied after render: a submit right after an edit must
  // see that edit.
  const runCreate = useCallback(() => void handleCreate(), [handleCreate])
  const composerSnapshot = useCallback(
    () =>
      buildComposerSnapshot(modalData, cardProps, {
        ...quickAgentPick,
        agent: quickAgent
      }),
    [cardProps, modalData, quickAgent, quickAgentPick]
  )
  const cloudStart = useCloudStartComposer({
    active,
    availability: cardProps.orcaCloudAvailability ?? 'unavailable',
    selectedRecipeId: cardProps.selectedEphemeralVmRecipeId ?? null,
    setRecipeId: cardProps.onEphemeralVmRecipeChange,
    repoId: cardProps.repoId,
    initialGitHubRepo: modalData.initialCloudGitHubRepo ?? null,
    openRepoPicker: modalData.openCloudRepoPicker === true,
    name: cardProps.name,
    agent: quickAgent,
    firstAgent,
    initialTargetFixed: Boolean(
      modalData.initialEphemeralVmRecipeId || modalData.initialWorkspaceTarget || modalData.recovery
    ),
    autoStartIntent: modalData.cloudAutoStart ? (modalData.cloudCreateIntent ?? null) : null,
    createReady: !createDisabled,
    composerSnapshot,
    onCreate: runCreate,
    onClose
  })
  useEffect(() => {
    recordCreatedRef.current = cloudStart.recordCreated
  }, [cloudStart.recordCreated, recordCreatedRef])
  // Create stays enabled; one that needs a GitHub repository stops and says so.
  const needsRepo = cloudStart.view?.needsGitHubRepo ?? null
  const guard = useNeedsRepoSubmitGuard(needsRepo, cloudStart.onPrimary ?? runCreate)
  const view = useMemo(
    () => cloudStart.view && { ...cloudStart.view, needsGitHubRepo: guard.shown },
    [cloudStart.view, guard.shown]
  )
  return {
    cloudStart: { ...cloudStart, view },
    // Local and Orca Cloud share one button: same label, same rules for when it's enabled.
    primaryCreateDisabled: createDisabled,
    onPrimary: guard.onPrimary
  }
}
