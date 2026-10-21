import { useEffect, useMemo, useRef } from 'react'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { signInToMachineProvider } from '@/lib/machines/machine-provider-actions'
import { useAppStore } from '@/store'
import type { ComposerMachineSelection } from './composer-machine-selection'

/** What the composer showed when sign-in closed it. */
export type ComposerSignInSnapshot = {
  name: string
  projectId: string | null
  hostId: ExecutionHostId | null
  projectHostSetupId: string | null
  ephemeralVmRecipeId: string | null
}

/** The composer's opening data, overlaid with what the user had picked and typed since. */
export function buildComposerReopenData(
  modalData: Record<string, unknown>,
  snapshot: ComposerSignInSnapshot
): Record<string, unknown> {
  return {
    ...modalData,
    prefilledName: snapshot.name,
    ...(snapshot.projectId && snapshot.hostId
      ? {
          initialWorkspaceTarget: {
            projectId: snapshot.projectId,
            hostId: snapshot.hostId,
            projectHostSetupId: snapshot.projectHostSetupId
          }
        }
      : {}),
    ...(snapshot.ephemeralVmRecipeId
      ? { initialEphemeralVmRecipeId: snapshot.ephemeralVmRecipeId }
      : {})
  }
}

/**
 * Signing in closes the dialog so the sign-in terminal isn't hidden under it. The modal composer
 * keeps no draft, so sign-in gets a way back to the same name, project, location and machine.
 */
export function useMachineSignInRestore(
  machineSelection: ComposerMachineSelection | null | undefined,
  modalData: Record<string, unknown>,
  snapshot: ComposerSignInSnapshot
): ComposerMachineSelection | null {
  const latest = useRef({ modalData, snapshot, machineSelection })
  useEffect(() => {
    latest.current = { modalData, snapshot, machineSelection }
  }, [machineSelection, modalData, snapshot])

  return useMemo(() => {
    if (!machineSelection) {
      return null
    }
    const { picker } = machineSelection
    return {
      ...machineSelection,
      picker: {
        ...picker,
        onProviderAction: (action) => {
          if (action.kind !== 'sign-in') {
            picker.onProviderAction(action)
            return
          }
          const current = latest.current
          const reopen = buildComposerReopenData(current.modalData, current.snapshot)
          const chosen = current.machineSelection?.selected?.machine ?? null
          const draft = current.machineSelection?.draft ?? null
          signInToMachineProvider(action.group.providerKey, () => {
            const store = useAppStore.getState()
            store.setComposerMachineRestore(
              chosen
                ? {
                    providerKey: chosen.providerKey,
                    machineId: chosen.machineId,
                    environmentId: chosen.environmentId
                  }
                : null
            )
            store.setComposerDraftRestore(draft)
            store.openModal('new-workspace-composer', reopen)
          })
        }
      }
    }
  }, [machineSelection])
}
