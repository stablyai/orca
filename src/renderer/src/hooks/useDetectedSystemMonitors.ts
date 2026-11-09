import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { getLocalAgentPreflightContext } from '@/lib/local-preflight-context'
import { localPreflightContextKey } from '@/lib/local-preflight-context-key'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import {
  resolveSystemMonitorDescriptors,
  type SystemMonitorDescriptor
} from '../../../shared/system-monitors'

const MONITOR_CACHE_MAX = 64
const cachedMonitorsByKey = new Map<string, SystemMonitorDescriptor[]>()
const inflightByKey = new Map<string, Promise<SystemMonitorDescriptor[]>>()

export function resetDetectedSystemMonitorsCacheForTests(): void {
  cachedMonitorsByKey.clear()
  inflightByKey.clear()
}

function setCachedMonitors(key: string, monitors: SystemMonitorDescriptor[]): void {
  if (cachedMonitorsByKey.size >= MONITOR_CACHE_MAX && !cachedMonitorsByKey.has(key)) {
    const oldestKey = cachedMonitorsByKey.keys().next().value
    if (oldestKey !== undefined) {
      cachedMonitorsByKey.delete(oldestKey)
    }
  }
  cachedMonitorsByKey.set(key, monitors)
}

function getMonitorTargetCacheKey(
  targetKind: 'local' | 'ssh' | 'runtime',
  environmentId: string | null,
  scopedWorktreeId: string
): string | null {
  if (targetKind === 'ssh') {
    return null
  }
  if (targetKind === 'runtime') {
    if (!environmentId) {
      return null
    }
    return `runtime:${environmentId}:${scopedWorktreeId || 'default'}`
  }
  const context = getLocalAgentPreflightContext(
    useAppStore.getState(),
    undefined,
    undefined,
    scopedWorktreeId
  )
  return `local:${localPreflightContextKey(context) ?? 'default'}`
}

async function fetchMonitorsForTarget(
  targetKind: 'local' | 'ssh' | 'runtime',
  environmentId: string | null,
  scopedWorktreeId: string
): Promise<SystemMonitorDescriptor[]> {
  if (targetKind === 'ssh') {
    return []
  }
  if (targetKind === 'runtime') {
    if (!environmentId) {
      return []
    }
    const ids = await callRuntimeRpc<unknown[]>(
      { kind: 'environment', environmentId },
      'preflight.detectMonitors',
      scopedWorktreeId ? { worktreeId: scopedWorktreeId } : {}
    )
    return resolveSystemMonitorDescriptors(Array.isArray(ids) ? ids : [])
  }
  const detectMonitors =
    typeof window !== 'undefined' ? window.api?.preflight?.detectMonitors : undefined
  if (!detectMonitors) {
    return []
  }
  const context = getLocalAgentPreflightContext(
    useAppStore.getState(),
    undefined,
    undefined,
    scopedWorktreeId
  )
  const ids = await detectMonitors({
    ...(context?.wslDistro ? { wslDistro: context.wslDistro } : {}),
    ...(context?.wslDefault ? { wslDefault: context.wslDefault } : {}),
    ...(context?.projectRuntime ? { projectRuntime: context.projectRuntime } : {}),
    wakeWslDistro: true
  })
  return resolveSystemMonitorDescriptors(Array.isArray(ids) ? ids : [])
}

const EMPTY_MONITORS: readonly SystemMonitorDescriptor[] = []

export function useDetectedSystemMonitors(
  worktreeId: string,
  enabled: boolean,
  target: AgentDetectionTarget | undefined
): readonly SystemMonitorDescriptor[] {
  const targetKind = target?.kind ?? 'local'
  const environmentId = target?.kind === 'runtime' ? target.environmentId : null
  const scopedWorktreeId =
    target?.kind === 'local' || target?.kind === 'runtime'
      ? (target.worktreeId ?? worktreeId)
      : worktreeId
  const cacheKey = getMonitorTargetCacheKey(targetKind, environmentId, scopedWorktreeId)
  const [monitors, setMonitors] = useState<readonly SystemMonitorDescriptor[]>(() =>
    cacheKey ? (cachedMonitorsByKey.get(cacheKey) ?? EMPTY_MONITORS) : EMPTY_MONITORS
  )

  useEffect(() => {
    if (!cacheKey) {
      setMonitors(EMPTY_MONITORS)
      return
    }
    const cached = cachedMonitorsByKey.get(cacheKey)
    if (cached) {
      setMonitors(cached)
    }
    if (!enabled) {
      return
    }
    let cancelled = false
    let pending = inflightByKey.get(cacheKey)
    if (!pending) {
      pending = fetchMonitorsForTarget(targetKind, environmentId, scopedWorktreeId)
        .then((resolved) => {
          if (resolved.length > 0) {
            setCachedMonitors(cacheKey, resolved)
          }
          return resolved
        })
        .catch(() => cachedMonitorsByKey.get(cacheKey) ?? [])
        .finally(() => {
          if (inflightByKey.get(cacheKey) === pending) {
            inflightByKey.delete(cacheKey)
          }
        })
      inflightByKey.set(cacheKey, pending)
    }
    void pending.then((resolved) => {
      if (!cancelled) {
        setMonitors(resolved.length > 0 ? resolved : EMPTY_MONITORS)
      }
    })
    return () => {
      cancelled = true
    }
  }, [cacheKey, enabled, environmentId, scopedWorktreeId, targetKind])

  return monitors
}
