import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { getLocalPreflightContext, localPreflightContextKey } from '@/lib/local-preflight-context'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { PreflightStatus } from '../../../../preload/api-types'
import {
  getRepoBackedProviderAvailability,
  type RuntimeProviderPreflightStatus
} from '../task-source-provider-availability'
import type { TaskSourceHostAvailability } from '../task-source-context-summary'
import {
  getRepoBackedAutomationSourceContext,
  getRuntimeSourceHostAvailability,
  type RepoBackedAutomationSourceContext
} from './automation-source-context'
import type { AutomationListRow } from './automation-list-row-identity'
import { createAutomationHostRequestPool } from './automation-host-scheduler-queue'

/**
 * Availability of each automation's *source* host — the host its task provider
 * is authenticated against, which can be a different machine from the one the
 * automation runs on. Provider auth and tooling therefore have to be checked
 * there, not on the run target.
 *
 * Each runtime source host is probed once per mount; the result is remembered
 * even when the probe fails, so a host that could not be reached reads as
 * checked-and-unknown rather than being dialled again on every render.
 *
 * Keyed by row, not by automation ID: two authorities may hold that ID, and
 * their copies can name different source hosts.
 */
export function useAutomationSourceHostAvailability(
  rows: readonly AutomationListRow[]
): ReadonlyMap<string, TaskSourceHostAvailability[]> {
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  const preflightStatus = useAppStore((s) => s.preflightStatus)
  const preflightStatusChecked = useAppStore((s) => s.preflightStatusChecked)
  const preflightStatusContextKey = useAppStore((s) => s.preflightStatusContextKey)
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)
  const expectedPreflightContextKey = useAppStore((s) =>
    localPreflightContextKey(getLocalPreflightContext(s))
  )
  const mountedRef = useRef(true)
  const requestedHostIdsRef = useRef<Set<TaskSourceContext['hostId']>>(new Set())
  const [requestPool] = useState(createAutomationHostRequestPool)
  const [statusByHostId, setStatusByHostId] = useState<
    ReadonlyMap<TaskSourceContext['hostId'], RuntimeProviderPreflightStatus>
  >(() => new Map())
  const preflightStatusCurrent = preflightStatusContextKey === expectedPreflightContextKey

  const sourceContexts = useMemo(
    () =>
      rows
        .map((row) => getRepoBackedAutomationSourceContext(row.automation))
        .filter((context): context is RepoBackedAutomationSourceContext => context !== null),
    [rows]
  )
  const runtimeSourceHostIds = useMemo(() => {
    const hostIds = new Set<TaskSourceContext['hostId']>()
    for (const context of sourceContexts) {
      const parsed = parseExecutionHostId(context.hostId)
      if (parsed?.kind !== 'runtime') {
        continue
      }
      if (getRuntimeSourceHostAvailability(context, runtimeStatusByEnvironmentId)) {
        continue
      }
      hostIds.add(parsed.id)
    }
    return [...hostIds].sort()
  }, [runtimeStatusByEnvironmentId, sourceContexts])

  useEffect(
    () => () => {
      mountedRef.current = false
      requestPool.cancelQueued()
    },
    [requestPool]
  )
  useEffect(() => {
    if (!preflightStatusCurrent || !preflightStatusChecked) {
      void refreshPreflightStatus()
    }
  }, [preflightStatusChecked, preflightStatusCurrent, refreshPreflightStatus])

  useEffect(() => {
    const unrequested = runtimeSourceHostIds.filter(
      (hostId) => !requestedHostIdsRef.current.has(hostId)
    )
    if (unrequested.length === 0) {
      return
    }
    const record = (hostId: TaskSourceContext['hostId'], status: PreflightStatus | null): void => {
      if (!mountedRef.current) {
        return
      }
      setStatusByHostId((current) => new Map(current).set(hostId, { checked: true, status }))
    }
    setStatusByHostId((current) => {
      const next = new Map(current)
      for (const hostId of unrequested) {
        next.set(hostId, { checked: false, status: null })
      }
      return next
    })
    for (const hostId of unrequested) {
      requestedHostIdsRef.current.add(hostId)
      const parsed = parseExecutionHostId(hostId)
      if (parsed?.kind !== 'runtime') {
        continue
      }
      void requestPool.submit({
        run: async () => {
          try {
            const status = await callRuntimeRpc<PreflightStatus>(
              { kind: 'environment', environmentId: parsed.environmentId },
              'preflight.check',
              undefined,
              { timeoutMs: 15_000 }
            )
            record(hostId, status)
          } catch {
            record(hostId, null)
          }
        }
      })
    }
  }, [requestPool, runtimeSourceHostIds])

  return useMemo(() => {
    const availabilityByRowKey = new Map<string, TaskSourceHostAvailability[]>()
    for (const row of rows) {
      const context = getRepoBackedAutomationSourceContext(row.automation)
      if (!context) {
        continue
      }
      const hostAvailability = getRuntimeSourceHostAvailability(
        context,
        runtimeStatusByEnvironmentId
      )
      const availability = [
        ...(hostAvailability ? [hostAvailability] : []),
        ...getRepoBackedProviderAvailability({
          provider: context.provider,
          contexts: [context],
          preflightStatus,
          preflightReady: preflightStatusCurrent && preflightStatusChecked,
          runtimePreflightStatusByHostId: statusByHostId
        })
      ]
      if (availability.length > 0) {
        availabilityByRowKey.set(row.key, availability)
      }
    }
    return availabilityByRowKey
  }, [
    rows,
    preflightStatus,
    preflightStatusChecked,
    preflightStatusCurrent,
    runtimeStatusByEnvironmentId,
    statusByHostId
  ])
}
