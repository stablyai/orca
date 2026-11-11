// The composer modal's side of Orca Cloud: feeds the composer state into useCloudStartComposer and
// returns what the primary button and ⌘↵ do.
import { useCallback, useEffect, type MutableRefObject } from 'react'
import type { ComposerModalData } from '../composer-modal-data'
import type { NewWorkspaceComposerCardProps } from '../new-workspace-composer-card-props'
import { useCloudStartComposer } from './use-cloud-start-composer'
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
  handleCreate,
  createDisabled,
  quickAgentPick,
  noAgentRef,
  recordCreatedRef,
  onClose
}: {
  active: boolean
  modalData: ComposerModalData
  cardProps: ComposerCardState
  quickAgent: TuiAgent | null
  handleCreate: () => Promise<void>
  /** Set right before a create to start it with no agent. */
  noAgentRef: MutableRefObject<boolean>
  createDisabled: boolean
  /** The agent pick (surface, draft) as the composer keeps it, for the setup page's snapshot. */
  quickAgentPick: Omit<NonNullable<ComposerModalData['recovery']>, 'note'>
  /** The composer's onCreated calls this: only a start that happened is remembered. */
  recordCreatedRef: MutableRefObject<(() => void) | null>
  onClose?: () => void
}) {
  // The latest handleCreate, never a ref copied after render: a submit right after an edit must
  // see that edit.
  const runCreate = useCallback(() => void handleCreate(), [handleCreate])
  const runCreateWithoutAgent = useCallback(() => {
    noAgentRef.current = true
    void handleCreate()
  }, [handleCreate, noAgentRef])
  const composerSnapshot = useCallback(
    () => buildComposerSnapshot(modalData, cardProps, { ...quickAgentPick, agent: quickAgent }),
    [cardProps, modalData, quickAgent, quickAgentPick]
  )
  const cloudStart = useCloudStartComposer({
    active,
    availability: cardProps.orcaCloudAvailability ?? 'unavailable',
    selectedRecipeId: cardProps.selectedEphemeralVmRecipeId ?? null,
    setRecipeId: cardProps.onEphemeralVmRecipeChange,
    repoId: cardProps.repoId,
    prompt: cardProps.name,
    agent: quickAgent,
    initialTargetFixed: Boolean(
      modalData.initialEphemeralVmRecipeId || modalData.initialWorkspaceTarget || modalData.recovery
    ),
    autoStartIntent: modalData.cloudAutoStart ? (modalData.cloudCreateIntent ?? null) : null,
    createReady: !createDisabled,
    composerSnapshot,
    onCreate: runCreate,
    onCreateWithoutAgent: runCreateWithoutAgent,
    onClose
  })
  useEffect(() => {
    recordCreatedRef.current = cloudStart.recordCreated
  }, [cloudStart.recordCreated, recordCreatedRef])
  return {
    cloudStart,
    // Local and Orca Cloud share one button: same label, same rules for when it's enabled.
    primaryCreateDisabled: createDisabled,
    onPrimary: cloudStart.onPrimary ?? runCreate
  }
}
