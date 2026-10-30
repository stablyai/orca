import { useState, type MutableRefObject } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { isRuntimeEnvironmentRemovalBlocked } from './runtime-environment-host-details'
import { defaultServerNameForAccessLink } from './runtime-server-default-name'
import { forgetCachedRuntimeHostDetails } from './use-runtime-environment-catalog'
import type { RuntimeHostAccessFailure } from './RuntimeHostAccessFailureAlert'
import { warnWslHostServerStop } from '../sidebar/wsl-host-removal'

type RuntimeEnvironmentMutationActionParams = {
  settings: GlobalSettings
  allowLocalRuntime: boolean
  mountedRef: MutableRefObject<boolean>
  setAddServerFormOpen: (open: boolean) => void
  loadEnvironments: (verified?: {
    environmentId: string
    runtimeStatus: RuntimeStatus
  }) => Promise<void>
  connectEnvironment: (environment: PublicKnownRuntimeEnvironment) => Promise<boolean>
}

export function useRuntimeEnvironmentMutationActions({
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
    const trimmedPairingCode = pairingCode.trim()
    const trimmedName =
      name.trim() ||
      defaultServerNameForAccessLink(trimmedPairingCode, useAppStore.getState().runtimeEnvironments)
    if (!trimmedName || !trimmedPairingCode) {
      toast.error(
        translate(
          'auto.components.settings.RuntimeEnvironmentsPane.0c55a47480',
          'Name and pairing code are required.'
        )
      )
      return
    }
    setAddServerFailure(null)
    setIsSaving(true)
    try {
      // Main distinguishes duplicate names from refreshing the same saved server.
      const result = await window.api.runtimeEnvironments.verifyAndAddFromPairingCode({
        name: trimmedName,
        pairingCode: trimmedPairingCode,
        allowLoopback
      })
      if (!result.ok) {
        if (mountedRef.current) {
          setAddServerFailure(result)
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
      if (result.updatedExisting && mountedRef.current) {
        toast.success(
          translate(
            'auto.components.settings.RuntimeEnvironmentsPane.serverAlreadyPaired',
            'This server is already paired as {{value0}}; updated its connection.',
            { value0: result.environment.name }
          )
        )
      }
      if (!allowLocalRuntime) {
        const connected = await connectEnvironment(result.environment)
        // Rollback must not remove an existing server refreshed by this pairing.
        if (!connected && !result.updatedExisting) {
          await window.api.runtimeEnvironments.remove({ selector: result.environment.id })
          await loadEnvironments()
          return
        }
      } else if (!result.updatedExisting) {
        if (mountedRef.current) {
          toast.success(
            translate(
              'auto.components.settings.RuntimeEnvironmentsPane.connectedNewProjectsHint',
              'Connected to {{value0}}. To create new projects there by default, choose it under New projects open on.',
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
              'auto.components.settings.RuntimeEnvironmentsPane.removeDefaultServerBlocked',
              'This server is the default host for new projects. Choose another one under New projects open on before removing it.'
            )
          )
        }
        return false
      }
      const removal = await window.api.runtimeEnvironments.remove({ selector: environment.id })
      forgetCachedRuntimeHostDetails(environment.id)
      await loadEnvironments()
      // A WSL host whose Remove couldn't prove its server stopped says so instead of "Removed".
      if (mountedRef.current && !warnWslHostServerStop(removal?.serverStop)) {
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
