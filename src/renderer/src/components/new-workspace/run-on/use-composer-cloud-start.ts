// The composer modal's side of "Start in Orca Cloud": feeds the composer state into
// useCloudStartComposer and returns what the primary button and ⌘↵ do.
import { useCallback, useEffect, type MutableRefObject } from 'react'
import type { ComposerModalData } from '../composer-modal-data'
import type { NewWorkspaceComposerCardProps } from '../new-workspace-composer-card-props'
import { useCloudStartComposer } from './use-cloud-start-composer'

type ComposerCardState = Pick<
  NewWorkspaceComposerCardProps,
  | 'orcaCloudAvailability'
  | 'selectedEphemeralVmRecipeId'
  | 'onEphemeralVmRecipeChange'
  | 'projectHostSetupOptions'
  | 'onProjectHostSetupChange'
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
  recordCreatedRef
}: {
  active: boolean
  modalData: ComposerModalData
  cardProps: ComposerCardState
  quickAgent: string | null
  handleCreate: () => Promise<void>
  createDisabled: boolean
  /** The composer's onCreated calls this: only a start that happened is remembered. */
  recordCreatedRef: MutableRefObject<(() => void) | null>
}) {
  // The latest handleCreate, never a ref copied after render: a submit right after an edit must
  // see that edit.
  const runCreate = useCallback(() => void handleCreate(), [handleCreate])
  const cloudStart = useCloudStartComposer({
    active,
    availability: cardProps.orcaCloudAvailability ?? 'unavailable',
    selectedRecipeId: cardProps.selectedEphemeralVmRecipeId ?? null,
    setRecipeId: cardProps.onEphemeralVmRecipeChange,
    hostOptions: cardProps.projectHostSetupOptions ?? [],
    onHostChange: cardProps.onProjectHostSetupChange,
    repoId: cardProps.repoId,
    prompt: cardProps.name,
    agent: quickAgent,
    initialTargetFixed: Boolean(
      modalData.initialEphemeralVmRecipeId || modalData.initialWorkspaceTarget || modalData.recovery
    ),
    onCreate: runCreate
  })
  useEffect(() => {
    recordCreatedRef.current = cloudStart.recordCreated
  }, [cloudStart.recordCreated, recordCreatedRef])
  const primaryCreateDisabled = cloudStart.primaryIsCreate
    ? createDisabled || cloudStart.primaryDisabled
    : cloudStart.primaryDisabled
  return {
    cloudStart,
    primaryCreateDisabled,
    onPrimary: cloudStart.onPrimary ?? runCreate
  }
}
