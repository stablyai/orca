import { useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { isRuntimeEnvironmentRemovalBlocked } from './runtime-environment-host-details'
import type { RuntimeHostAccessFailure } from './RuntimeHostAccessForm'

type RuntimeEnvironmentMutationActionParams = {
  environments: PublicKnownRuntimeEnvironment[]
  settings: GlobalSettings
  allowLocalRuntime: boolean
  mountedRef: MutableRefObject<boolean>
  setAddServerFormOpen: Dispatch<SetStateAction<boolean>>
  loadEnvironments: (verified?: {
    environmentId: string
    runtimeStatus: RuntimeStatus
  }) => Promise<void>
  connectEnvironment: (environment: PublicKnownRuntimeEnvironment) => Promise<boolean>
}

export function useRuntimeEnvironmentMutationActions({
  environments,
  settings,
  allowLocalRuntime,
  mountedRef,
  setAddServerFormOpen,
  loadEnvironments,
  connectEnvironment
}: RuntimeEnvironmentMutationActionParams) {
  const [isSaving, setIsSaving] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [pairingCode, setPairingCode] = useState('')
  const [addServerFailure, setAddServerFailure] = useState<RuntimeHostAccessFailure | null>(null)

  const closeAddServerForm = (): void => {
    if (isSaving) {
      return
    }
    setAddServerFormOpen(false)
    setName('')
    setPairingCode('')
    setAddServerFailure(null)
  }

  const addEnvironment = async (allowLoopback: boolean): Promise<void> => {
    const trimmedName = name.trim()
    const trimmedPairingCode = pairingCode.trim()
    if (!trimmedName || !trimmedPairingCode) {
      toast.error(
        translate(
          'auto.components.settings.RuntimeEnvironmentsPane.0c55a47480',
          'Name and pairing code are required.'
        )
      )
      return
    }
    const duplicate = environments.find(
      (environment) => environment.name.trim().toLowerCase() === trimmedName.toLowerCase()
    )
    if (duplicate) {
      toast.error(
        translate(
          'auto.components.settings.RuntimeEnvironmentsPane.5ef712f407',
          'A server named "{{value0}}" already exists.',
          { value0: duplicate.name }
        )
      )
      return
    }
    setAddServerFailure(null)
    setIsSaving(true)
    try {
      const result = await window.api.runtimeEnvironments.verifyAndAddFromPairingCode({
        name: trimmedName,
        pairingCode: trimmedPairingCode,
        allowLoopback
      })
      if (!result.ok) {
        if (mountedRef.current) {
          setAddServerFailure({ kind: result.kind, message: result.message })
        }
        return
      }
      if (mountedRef.current) {
        setName('')
        setPairingCode('')
      }
      await loadEnvironments({
        environmentId: result.environment.id,
        runtimeStatus: result.runtimeStatus
      })
      if (!allowLocalRuntime) {
        const connected = await connectEnvironment(result.environment)
        if (!connected) {
          await window.api.runtimeEnvironments.remove({ selector: result.environment.id })
          await loadEnvironments()
          return
        }
      } else {
        if (mountedRef.current) {
          toast.success(
            translate(
              'auto.components.settings.RuntimeEnvironmentsPane.7b5986c8df',
              'Connected to {{value0}}. Use Advanced > Active Server to make it the default.',
              { value0: result.environment.name }
            )
          )
        }
      }
      if (mountedRef.current) {
        setAddServerFormOpen(false)
      }
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.settings.RuntimeEnvironmentsPane.6cb6eae14f',
                'Failed to save runtime environment.'
              )
        )
      }
    } finally {
      if (mountedRef.current) {
        setIsSaving(false)
      }
    }
  }

  const removeEnvironment = async (
    environment: PublicKnownRuntimeEnvironment
  ): Promise<boolean> => {
    setRemovingId(environment.id)
    setRemoveError(null)
    try {
      if (isRuntimeEnvironmentRemovalBlocked(settings.activeRuntimeEnvironmentId, environment.id)) {
        if (mountedRef.current) {
          setRemoveError(
            translate(
              'auto.components.settings.RuntimeEnvironmentsPane.removeActiveServerBlocked',
              'Choose another Active Server in Advanced before removing this server.'
            )
          )
        }
        return false
      }
      await window.api.runtimeEnvironments.remove({ selector: environment.id })
      await loadEnvironments()
      if (mountedRef.current) {
        toast.success(
          translate(
            'auto.components.settings.RuntimeEnvironmentsPane.b5b5114cb0',
            'Removed {{value0}}.',
            { value0: environment.name }
          )
        )
      }
      return true
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to remove runtime environment.'
      if (mountedRef.current) {
        setRemoveError(message)
        toast.error(message)
      }
      return false
    } finally {
      if (mountedRef.current) {
        setRemovingId(null)
      }
    }
  }

  return {
    isSaving,
    removingId,
    removeError,
    setRemoveError,
    name,
    setName,
    pairingCode,
    setPairingCode,
    addServerFailure,
    setAddServerFailure,
    closeAddServerForm,
    addEnvironment,
    removeEnvironment
  }
}
