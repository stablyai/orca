import { useCallback, useEffect, useRef, useState } from 'react'
import type { PreflightStatus } from '../../../../../preload/api/preflight/preflight-api'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type {
  AzureDevOpsAuthMethod,
  AzureDevOpsAuthStatus
} from '../../../../../shared/source-control/azure-devops-auth-types'
import { normalizeAzureDevOpsAuthMethod } from '../../../../../shared/source-control/azure-devops-auth-types'
import { callRuntimeRpcResponse } from '@/runtime/rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { useAppStore } from '@/store'

type SettingsResult = { settings: { azureDevOpsAuthMethod?: AzureDevOpsAuthMethod } }

export type AzureDevOpsHostAuth = {
  method?: AzureDevOpsAuthMethod
  status?: AzureDevOpsAuthStatus
  phase: 'loading' | 'ready' | 'unsupported' | 'unavailable'
  checking: boolean
  saving?: boolean
  saveFailed?: boolean
}

const INITIAL: AzureDevOpsHostAuth = { phase: 'loading', checking: true }
const UNAVAILABLE: AzureDevOpsHostAuth = { phase: 'unavailable', checking: false }

type HostRequest = { signal: AbortSignal; runtimeId?: string; busy: boolean }

export function useAzureDevOpsHostAuth(
  target: RuntimeClientTarget | null,
  pairingRevision?: number
) {
  const environmentId = target?.kind === 'environment' ? target.environmentId : null
  const available = target !== null
  const [state, setState] = useState<AzureDevOpsHostAuth>(INITIAL)
  const active = useRef<HostRequest | null>(null)

  const call = useCallback(
    <TResult>(method: string, params: unknown, owner: HostRequest) => {
      if (!environmentId) {
        throw new Error('Azure DevOps runtime environment is unavailable')
      }
      return callRuntimeRpcResponse<TResult>(
        { kind: 'environment', environmentId },
        method,
        params,
        {
          timeoutMs: 30_000,
          beforeSend: () => owner.signal.throwIfAborted(),
          expectedEnvironmentPairingRevision: pairingRevision,
          expectedEnvironmentRuntimeId: owner.runtimeId
        }
      )
    },
    [environmentId, pairingRevision]
  )

  const check = useCallback(
    async (owner: HostRequest, force: boolean) => {
      let method: AzureDevOpsAuthMethod | undefined
      let unsupported = false
      try {
        if (environmentId) {
          try {
            const response = await call<SettingsResult>('settings.get', undefined, owner)
            owner.runtimeId = response._meta.runtimeId
            method = response.result.settings.azureDevOpsAuthMethod
            unsupported = method !== 'environment' && method !== 'azure-cli'
          } catch (error) {
            if (!(error instanceof RuntimeRpcCallError) || error.code !== 'method_not_found') {
              throw error
            }
            unsupported = true
          }
        } else {
          const settings = await window.api.settings.get()
          method = normalizeAzureDevOpsAuthMethod(settings.azureDevOpsAuthMethod)
        }
        if (owner.signal.aborted) {
          return
        }
        const params = force
          ? { force: true, ...(!unsupported && { refreshAzureDevOps: true }) }
          : undefined
        const status = environmentId
          ? (await call<PreflightStatus>('preflight.check', params, owner)).result.azureDevOps
          : (await window.api.preflight.check(params)).azureDevOps
        if (!owner.signal.aborted) {
          const currentStatus =
            status?.authMethod && status.authMethod !== method ? undefined : status
          setState({
            method: unsupported ? 'environment' : method,
            phase: unsupported ? 'unsupported' : 'ready',
            checking: false,
            status: currentStatus
          })
          if (force) {
            useAppStore.getState().invalidatePreflightStatus()
          }
        }
      } catch (error) {
        if (!owner.signal.aborted) {
          const oldHost =
            unsupported && error instanceof RuntimeRpcCallError && error.code === 'method_not_found'
          setState((previous) => ({
            phase: oldHost ? 'unsupported' : 'unavailable',
            checking: false,
            method: oldHost ? 'environment' : (method ?? previous.method)
          }))
        }
      } finally {
        owner.busy = false
      }
    },
    [call, environmentId]
  )

  useEffect(() => {
    if (!available) {
      return
    }
    const controller = new AbortController()
    const owner = { signal: controller.signal, busy: true }
    active.current = owner
    void check(owner, false)
    return () => {
      controller.abort()
      active.current = null
    }
  }, [available, check])

  function refresh(): void {
    const owner = active.current
    if (!owner || owner.busy) {
      return
    }
    owner.busy = true
    // Re-read the same pairing after a restart before pinning another write to its runtime.
    owner.runtimeId = undefined
    setState((previous) => ({ ...previous, checking: true, saveFailed: false }))
    void check(owner, true)
  }

  async function save(method: AzureDevOpsAuthMethod): Promise<void> {
    const owner = active.current
    if (!owner || owner.busy || state.phase !== 'ready' || state.method === method) {
      return
    }
    owner.busy = true
    setState((previous) => ({ ...previous, saving: true, saveFailed: false }))
    const updates = { azureDevOpsAuthMethod: method }
    try {
      const settings = environmentId
        ? (await call<SettingsResult>('settings.update', updates, owner)).result.settings
        : await window.api.settings.set(updates)
      if (settings.azureDevOpsAuthMethod !== method) {
        throw new Error('The host did not confirm the Azure DevOps authentication method')
      }
    } catch {
      if (!owner.signal.aborted) {
        setState((previous) => ({ ...previous, saving: false, saveFailed: true }))
      }
      owner.busy = false
      return
    }
    if (!owner.signal.aborted) {
      setState({ method, phase: 'ready', checking: true })
      useAppStore.getState().invalidatePreflightStatus()
      await check(owner, false)
    }
  }

  return { state: available ? state : UNAVAILABLE, refresh, save }
}
