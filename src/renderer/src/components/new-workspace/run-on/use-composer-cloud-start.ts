// The composer modal's side of Orca Cloud: feeds the composer state into useCloudStartComposer and
// returns what the primary button and ⌘↵ do.
import { useCallback, useEffect, type MutableRefObject } from 'react'
import type { ComposerModalData } from '../composer-modal-data'
import type { NewWorkspaceComposerCardProps } from '../new-workspace-composer-card-props'
import { useCloudStartComposer } from './use-cloud-start-composer'

type ComposerCardState = Pick<
  NewWorkspaceComposerCardProps,
  | 'orcaCloudAvailability'
  | 'selectedEphemeralVmRecipeId'
  | 'onEphemeralVmRecipeChange'
  | 'repoId'
  | 'name'
>

export function useComposerCloudStart({
  active,
  modalData,
  cardProps,
  quickAgent,
  handleCreate,
  createDisabled,
  composerSnapshot,
  recordCreatedRef,
  onClose
}: {
  active: boolean
  modalData: ComposerModalData
  cardProps: ComposerCardState
  quickAgent: string | null
  handleCreate: () => Promise<void>
  createDisabled: boolean
  composerSnapshot: () => ComposerModalData
  /** The composer's onCreated calls this: only a start that happened is remembered. */
  recordCreatedRef: MutableRefObject<(() => void) | null>
  onClose?: () => void
}) {
  // The latest handleCreate, never a ref copied after render: a submit right after an edit must
  // see that edit.
  const runCreate = useCallback(() => void handleCreate(), [handleCreate])
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
    autoStart: modalData.cloudAutoStart === true,
    createReady: !createDisabled,
    composerSnapshot,
    onCreate: runCreate,
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
