import { useState, type MutableRefObject } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { RuntimeStatus } from '../../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { isRuntimeEnvironmentRemovalBlocked } from './runtime-environment-host-details'
import { defaultServerNameForAccessLink } from '../../../../../../shared/remote-runtime/host-catalog/runtime-host-default-name'
import { forgetCachedRuntimeHostDetails } from './use-runtime-environment-catalog'
import type { RuntimeHostAccessFailure } from '../../../runtime-access/RuntimeHostAccessFailureAlert'
import { warnWslHostServerStop } from '../../../sidebar/host-lifecycle/wsl-host-removal'
import type { RuntimeHostSshRoute } from '../../../runtime-access/RuntimeHostAccessForm'
import type { ManagedOrcadPreloadApi } from '../../../../../../preload/api/runtime/managed-orcad-api'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'

type AddServerSshRoute = RuntimeHostSshRoute & {
  api: Pick<ManagedOrcadPreloadApi, 'linkSshAccess'>
}

/** Saves the pairing, then links it through SSH the way Settings' SSH access does; the link verifies over the tunnel. */
async function addEnvironmentThroughSshRoute(args: {
  name: string
  pairingCode: string
  route: AddServerSshRoute
}): Promise<{ environment: PublicKnownRuntimeEnvironment; updatedExisting: boolean }> {
  const knownIds = new Set(useAppStore.getState().runtimeEnvironments.map((entry) => entry.id))
  const { environment } = await window.api.runtimeEnvironments.addFromPairingCode({
    name: args.name,
    pairingCode: args.pairingCode
  })
  const updatedExisting = knownIds.has(environment.id)
  try {
    await args.route.api.linkSshAccess({
      selector: environment.id,
      requestId: createBrowserUuid(),
      sshTargetId: args.route.sshTargetId,
      remotePort: args.route.remotePort
    })
  } catch (error) {
    if (!updatedExisting) {
      await window.api.runtimeEnvironments.remove({ selector: environment.id }).catch(() => {})
    }
    throw error
  }
  return { environment, updatedExisting }
}

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
  const t = useTranslate()
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

  const addEnvironment = async (
    allowLoopback: boolean,
    sshRoute?: AddServerSshRoute
  ): Promise<void> => {
    const trimmedPairingCode = pairingCode.trim()
    const trimmedName =
      name.trim() ||
      defaultServerNameForAccessLink(trimmedPairingCode, useAppStore.getState().runtimeEnvironments)
    if (!trimmedName || !trimmedPairingCode) {
      toast.error(
        t(
          'auto.components.settings.RuntimeEnvironmentsPane.0c55a47480',
          'Name and pairing code are required.'
        )
      )
      return
    }
    setAddServerFailure(null)
    setIsSaving(true)
    try {
      let result: { environment: PublicKnownRuntimeEnvironment; updatedExisting?: boolean }
      if (sshRoute) {
        result = await addEnvironmentThroughSshRoute({
          name: trimmedName,
          pairingCode: trimmedPairingCode,
          route: sshRoute
        })
        if (mountedRef.current) {
          setName('')
          setPairingCode('')
        }
        await loadEnvironments()
      } else {
        // Main distinguishes duplicate names from refreshing the same saved server.
        const verified = await window.api.runtimeEnvironments.verifyAndAddFromPairingCode({
          name: trimmedName,
          pairingCode: trimmedPairingCode,
          allowLoopback
        })
        if (!verified.ok) {
          if (mountedRef.current) {
            setAddServerFailure(verified)
          }
          return
        }
        result = verified
        if (mountedRef.current) {
          setName('')
          setPairingCode('')
        }
        await loadEnvironments({
          environmentId: verified.environment.id,
          runtimeStatus: verified.runtimeStatus
        })
      }
      if (result.updatedExisting && mountedRef.current) {
        toast.success(
          t(
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
            t(
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
            : t(
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
            t(
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
          t('auto.components.settings.RuntimeEnvironmentsPane.b5b5114cb0', 'Removed {{value0}}.', {
            value0: environment.name
          })
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
