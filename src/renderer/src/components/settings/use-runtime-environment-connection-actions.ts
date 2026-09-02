import { useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-client'
import { extractRuntimeTransportDiagnostics } from '@/runtime/runtime-status-probe-diagnostics'
import { useAppStore } from '@/store'
import { describeRuntimeCompatBlock } from '../../../../shared/protocol-compat'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { evaluateHostDetails, type RuntimeHostDetails } from './runtime-environment-host-details'
import { LOCAL_RUNTIME_VALUE, NO_RUNTIME_VALUE } from './runtime-environment-selection'
import { refreshRuntimeProjectWorktreesAndLineage } from '@/hooks/runtime-project-refresh-scheduler'

type RuntimeEnvironmentConnectionActionParams = {
  allowLocalRuntime: boolean
  mountedRef: MutableRefObject<boolean>
  setDetailsByEnvironmentId: Dispatch<SetStateAction<Record<string, RuntimeHostDetails>>>
  setActiveRuntimeEnvironmentPreference: (environmentId: string | null) => Promise<boolean>
  getEnvironmentLabel: (value: string) => string
}

export function useRuntimeEnvironmentConnectionActions({
  allowLocalRuntime,
  mountedRef,
  setDetailsByEnvironmentId,
  setActiveRuntimeEnvironmentPreference,
  getEnvironmentLabel
}: RuntimeEnvironmentConnectionActionParams) {
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const [switchingValue, setSwitchingValue] = useState<string | null>(null)
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)

  const disconnectEnvironment = async (
    environment: PublicKnownRuntimeEnvironment
  ): Promise<boolean> => {
    setDisconnectingId(environment.id)
    setSwitchError(null)
    try {
      await window.api.runtimeEnvironments.disconnect({ selector: environment.id })
      // Why: disconnect is non-destructive; keep the saved server but show the
      // user that this live client is no longer attached to it.
      useAppStore.getState().setRuntimeEnvironmentStatus(
        environment.id,
        {
          status: null,
          checkedAt: Date.now()
        },
        { suppressDisconnectToast: true }
      )
      if (mountedRef.current) {
        setDetailsByEnvironmentId((current) => ({
          ...current,
          [environment.id]: {
            status: 'error',
            runtimeStatus: null,
            remoteControl: null,
            compatibility: null,
            error: null
          }
        }))
        toast.success(
          translate(
            'auto.components.settings.RuntimeEnvironmentsPane.disconnectedServer',
            'Disconnected from {{value0}}.',
            { value0: environment.name }
          )
        )
      }
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to disconnect server.'
      if (mountedRef.current) {
        setSwitchError(message)
        toast.error(message)
      }
      return false
    } finally {
      if (mountedRef.current) {
        setDisconnectingId(null)
      }
    }
  }

  const connectEnvironment = async (
    environment: PublicKnownRuntimeEnvironment
  ): Promise<boolean> => {
    setConnectingId(environment.id)
    setSwitchError(null)
    try {
      const response = await window.api.runtimeEnvironments.connect({
        selector: environment.id,
        timeoutMs: 15_000
      })
      const runtimeStatus = unwrapRuntimeRpcResult<RuntimeStatus>(response)
      const compatibility = evaluateHostDetails(runtimeStatus)
      // Why: row Connect is reachability only. The Advanced selector is the
      // explicit default-host control and should be the only active-server path.
      useAppStore.getState().setRuntimeEnvironmentStatus(environment.id, {
        status: runtimeStatus,
        checkedAt: Date.now()
      })
      if (mountedRef.current) {
        setDetailsByEnvironmentId((current) => ({
          ...current,
          [environment.id]: {
            status: 'ready',
            runtimeStatus,
            remoteControl: runtimeStatus.remoteControl ?? null,
            compatibility,
            error: null
          }
        }))
      }
      if (compatibility.kind === 'blocked') {
        const message = describeRuntimeCompatBlock(compatibility)
        if (mountedRef.current) {
          setSwitchError(message)
          toast.error(message)
        }
        return false
      }
      const store = useAppStore.getState()
      // Why: Connect is not the Active Server selector anymore, but connected
      // hosts should still contribute their projects/workspaces to the sidebar.
      const repos = await store.fetchRuntimeEnvironmentRepos(environment.id)
      await refreshRuntimeProjectWorktreesAndLineage(
        environment.id,
        repos,
        (repoId, options) => useAppStore.getState().fetchWorktrees(repoId, options),
        (options) => useAppStore.getState().fetchWorktreeLineage(options)
      )
      if (mountedRef.current) {
        toast.success(
          translate(
            'auto.components.settings.RuntimeEnvironmentsPane.runtimeReachable',
            '{{value0}} is reachable.',
            { value0: environment.name }
          )
        )
      }
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to connect server.'
      const remoteControl = extractRuntimeTransportDiagnostics(error)
      useAppStore.getState().setRuntimeEnvironmentStatus(environment.id, {
        status: null,
        ...(remoteControl ? { remoteControl } : {}),
        checkedAt: Date.now()
      })
      if (mountedRef.current) {
        setDetailsByEnvironmentId((current) => ({
          ...current,
          [environment.id]: {
            status: 'error',
            runtimeStatus: null,
            remoteControl: remoteControl ?? null,
            compatibility: null,
            error: message
          }
        }))
        setSwitchError(message)
        toast.error(message)
      }
      return false
    } finally {
      if (mountedRef.current) {
        setConnectingId(null)
      }
    }
  }

  const switchToValue = async (value: string): Promise<boolean> => {
    if (value === NO_RUNTIME_VALUE) {
      return false
    }
    setSwitchingValue(value)
    setSwitchError(null)
    try {
      const switched = await setActiveRuntimeEnvironmentPreference(
        allowLocalRuntime && value === LOCAL_RUNTIME_VALUE ? null : value
      )
      if (switched) {
        if (mountedRef.current) {
          toast.success(
            translate(
              'auto.components.settings.RuntimeEnvironmentsPane.99ac81fb43',
              'Switched to {{value0}}.',
              { value0: getEnvironmentLabel(value) }
            )
          )
        }
        return true
      }
      if (mountedRef.current) {
        setSwitchError('Could not switch servers. Fix the issue and try again.')
      }
      return false
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to switch servers.'
      if (mountedRef.current) {
        setSwitchError(message)
        toast.error(message)
      }
      return false
    } finally {
      if (mountedRef.current) {
        setSwitchingValue(null)
      }
    }
  }

  return {
    connectingId,
    switchingValue,
    disconnectingId,
    switchError,
    setSwitchError,
    connectEnvironment,
    disconnectEnvironment,
    switchToValue
  }
}
