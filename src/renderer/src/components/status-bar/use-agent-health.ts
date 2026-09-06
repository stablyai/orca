import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentHealthProvider,
  AgentHealthSnapshot,
  AgentUpdateResult
} from '../../../../shared/agent-health'
import { useAppStore } from '../../store'
import { getLocalAgentPreflightContext } from '@/lib/local-preflight-context'
import { callRuntimeRpc, RuntimeRpcCallError } from '@/runtime/runtime-rpc-client'

const AGENT_HEALTH_POLL_MS = 15 * 60_000
const AGENT_HEALTH_TIMEOUT_MS = 35_000
const AGENT_UPDATE_TIMEOUT_MS = 5 * 60_000 + 15_000
const AGENT_HEALTH_PROVIDERS = ['claude', 'codex'] as const

type AgentHealthProbeState = {
  snapshots: AgentHealthSnapshot[]
  isProbing: boolean
  pendingProviders: Partial<Record<AgentHealthProvider, boolean>>
  loadError: boolean
  updateStates: Partial<Record<AgentHealthProvider, AgentUpdateUiState>>
  refresh: () => Promise<AgentHealthSnapshot[]>
  check: (provider: AgentHealthProvider) => Promise<AgentHealthSnapshot | null>
  update: (provider: AgentHealthProvider) => Promise<AgentUpdateResult | null>
}

export type AgentUpdateUiState = {
  status: 'updating' | 'updated' | 'current' | 'failed'
  version: string | null
}

async function requestLegacyAgentHealth(environmentId: string): Promise<AgentHealthSnapshot[]> {
  try {
    return await callRuntimeRpc<AgentHealthSnapshot[]>(
      { kind: 'environment', environmentId },
      'preflight.probeAgentHealth',
      undefined,
      { timeoutMs: AGENT_HEALTH_TIMEOUT_MS }
    )
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return []
    }
    throw error
  }
}

async function requestAgentHealthProvider(
  environmentId: string | null,
  provider: AgentHealthProvider,
  requestLegacy: () => Promise<AgentHealthSnapshot[]>
): Promise<AgentHealthSnapshot | null> {
  if (!environmentId) {
    const context = getLocalAgentPreflightContext(useAppStore.getState())
    return window.api.preflight.probeAgentHealthProvider({ ...context, provider })
  }
  try {
    return await callRuntimeRpc<AgentHealthSnapshot>(
      { kind: 'environment', environmentId },
      'preflight.probeAgentHealthProvider',
      { provider },
      { timeoutMs: AGENT_HEALTH_TIMEOUT_MS }
    )
  } catch (error) {
    if (!(error instanceof RuntimeRpcCallError) || error.code !== 'method_not_found') {
      throw error
    }
    const snapshots = await requestLegacy()
    return snapshots.find((snapshot) => snapshot.provider === provider) ?? null
  }
}

async function requestAgentUpdate(
  environmentId: string | null,
  provider: AgentHealthProvider
): Promise<AgentUpdateResult> {
  if (!environmentId) {
    const context = getLocalAgentPreflightContext(useAppStore.getState())
    return window.api.preflight.updateAgent({ ...context, provider })
  }
  return callRuntimeRpc<AgentUpdateResult>(
    { kind: 'environment', environmentId },
    'preflight.updateAgent',
    { provider },
    { timeoutMs: AGENT_UPDATE_TIMEOUT_MS }
  )
}

export function useAgentHealth(
  environmentId: string | null,
  enabled = true
): AgentHealthProbeState {
  const [snapshots, setSnapshots] = useState<AgentHealthSnapshot[]>([])
  const [pendingProviders, setPendingProviders] = useState<
    Partial<Record<AgentHealthProvider, boolean>>
  >({})
  const [failedProviders, setFailedProviders] = useState<
    Partial<Record<AgentHealthProvider, boolean>>
  >({})
  const [updateStates, setUpdateStates] = useState<
    Partial<Record<AgentHealthProvider, AgentUpdateUiState>>
  >({})
  const targetKey = environmentId ? `runtime:${environmentId}` : 'local'
  const targetKeyRef = useRef(targetKey)
  const pendingRef = useRef(new Map<string, Promise<AgentHealthSnapshot | null>>())
  const legacyPendingRef = useRef(new Map<string, Promise<AgentHealthSnapshot[]>>())
  const mountedRef = useRef(true)
  const updatePendingRef = useRef(new Map<string, Promise<AgentUpdateResult | null>>())

  useEffect(() => {
    targetKeyRef.current = targetKey
  }, [targetKey])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const check = useCallback(
    (provider: AgentHealthProvider): Promise<AgentHealthSnapshot | null> => {
      if (!enabled) {
        return Promise.resolve(null)
      }
      const pendingKey = `${targetKey}:${provider}`
      const existing = pendingRef.current.get(pendingKey)
      if (existing) {
        return existing
      }
      setPendingProviders((states) => ({ ...states, [provider]: true }))
      const requestLegacy = (): Promise<AgentHealthSnapshot[]> => {
        if (!environmentId) {
          return Promise.resolve([])
        }
        const existingLegacy = legacyPendingRef.current.get(targetKey)
        if (existingLegacy) {
          return existingLegacy
        }
        const legacyPending = requestLegacyAgentHealth(environmentId).finally(() => {
          legacyPendingRef.current.delete(targetKey)
        })
        legacyPendingRef.current.set(targetKey, legacyPending)
        return legacyPending
      }
      const pending = requestAgentHealthProvider(environmentId, provider, requestLegacy)
        .then((next) => {
          if (mountedRef.current && targetKeyRef.current === targetKey) {
            if (next) {
              setSnapshots((current) => [
                ...current.filter((snapshot) => snapshot.provider !== provider),
                next
              ])
            }
            setFailedProviders((states) => ({ ...states, [provider]: false }))
          }
          return next
        })
        .catch((error) => {
          if (mountedRef.current && targetKeyRef.current === targetKey) {
            setFailedProviders((states) => ({ ...states, [provider]: true }))
          }
          throw error
        })
        .finally(() => {
          pendingRef.current.delete(pendingKey)
          if (mountedRef.current && targetKeyRef.current === targetKey) {
            setPendingProviders((states) => ({ ...states, [provider]: false }))
          }
        })
      pendingRef.current.set(pendingKey, pending)
      return pending
    },
    [enabled, environmentId, targetKey]
  )

  const refresh = useCallback((): Promise<AgentHealthSnapshot[]> => {
    if (!enabled) {
      return Promise.resolve([])
    }
    return Promise.allSettled(AGENT_HEALTH_PROVIDERS.map((provider) => check(provider))).then(
      (results) => {
        const failure = results.find((result) => result.status === 'rejected')
        if (failure?.status === 'rejected') {
          throw failure.reason
        }
        return results.flatMap((result) =>
          result.status === 'fulfilled' && result.value ? [result.value] : []
        )
      }
    )
  }, [check, enabled])

  const update = useCallback(
    (provider: AgentHealthProvider): Promise<AgentUpdateResult | null> => {
      const updateKey = `${targetKey}:${provider}`
      const existing = updatePendingRef.current.get(updateKey)
      if (existing) {
        return existing
      }
      setUpdateStates((states) => ({
        ...states,
        [provider]: { status: 'updating', version: null }
      }))
      const pending = requestAgentUpdate(environmentId, provider)
        .then((result) => {
          if (mountedRef.current && targetKeyRef.current === targetKey) {
            setUpdateStates((states) => ({
              ...states,
              [provider]: { status: result.outcome, version: result.currentVersion }
            }))
            void check(provider).catch(() => {})
          }
          return result
        })
        .catch(() => {
          if (mountedRef.current && targetKeyRef.current === targetKey) {
            setUpdateStates((states) => ({
              ...states,
              [provider]: { status: 'failed', version: null }
            }))
          }
          return null
        })
        .finally(() => updatePendingRef.current.delete(updateKey))
      updatePendingRef.current.set(updateKey, pending)
      return pending
    },
    [check, environmentId, targetKey]
  )

  useEffect(() => {
    setSnapshots([])
    setPendingProviders({})
    setFailedProviders({})
    setUpdateStates({})
    if (!enabled) {
      return
    }
    void refresh().catch(() => {})
    const interval = window.setInterval(() => void refresh().catch(() => {}), AGENT_HEALTH_POLL_MS)
    return () => window.clearInterval(interval)
  }, [enabled, refresh])

  const isProbing = AGENT_HEALTH_PROVIDERS.some((provider) => pendingProviders[provider] === true)
  const loadError = AGENT_HEALTH_PROVIDERS.some((provider) => failedProviders[provider] === true)
  return {
    snapshots,
    isProbing,
    pendingProviders,
    loadError,
    updateStates,
    refresh,
    check,
    update
  }
}
