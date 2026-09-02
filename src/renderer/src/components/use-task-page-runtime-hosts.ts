import type { TaskPageRepoSelectionModel } from './use-task-page-repo-selection'
import { normalizeGitHubTaskPreset } from '@/components/task-page-github-task-kind'
import { getTaskPresetQuery } from '../../../shared/task-preset-query'
import { useState, useRef, useEffect, useMemo } from 'react'
import type { TaskProvider } from '../../../shared/task-providers'
import { resolveVisibleTaskProvider } from '../../../shared/task-providers'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { RuntimeProviderPreflightStatus } from '@/components/task-source-provider-availability'
import { buildExecutionHostRegistry } from '../../../shared/execution-host-registry'
import { getHostDisplayLabelOverrides } from '../../../shared/host-setting-overrides'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { PreflightStatus } from '../../../preload/api-types'
import { getTaskPageRepoSourceContext } from './task-page-source-context'
export function useTaskPageRuntimeHosts(model: TaskPageRepoSelectionModel) {
  const {
    settings,
    pageData,
    repos,
    sshConnectionStates,
    sshTargetLabels,
    runtimeEnvironments,
    runtimeStatusByEnvironmentId,
    selectedRepos,
    defaultTaskSource,
    visibleTaskProviders
  } = model
  // Why: seed preset + query synchronously so the first fetch issues one request; a prior post-mount re-seed caused a throwaway empty-query fetch, doubling time-to-first-paint.
  const defaultTaskViewPreset = normalizeGitHubTaskPreset(settings?.defaultTaskViewPreset ?? 'all')
  const initialTaskQuery = getTaskPresetQuery(defaultTaskViewPreset)
  const preferredTaskSource = pageData.taskSource ?? defaultTaskSource
  const [taskSource, setTaskSource] = useState<TaskProvider>(
    resolveVisibleTaskProvider(preferredTaskSource, visibleTaskProviders)
  )
  const runtimePreflightMountedRef = useRef(true)
  const runtimePreflightRequestedHostIdsRef = useRef<Set<TaskSourceContext['hostId']>>(new Set())
  const [runtimePreflightStatusByHostId, setRuntimePreflightStatusByHostId] = useState<
    ReadonlyMap<TaskSourceContext['hostId'], RuntimeProviderPreflightStatus>
  >(() => new Map())
  useEffect(
    () => () => {
      runtimePreflightMountedRef.current = false
    },
    []
  )
  const taskSourceRepoContexts = useMemo(
    () =>
      taskSource === 'github' || taskSource === 'gitlab'
        ? selectedRepos
            .map((repo) => getTaskPageRepoSourceContext(repo, taskSource))
            .filter((context): context is TaskSourceContext => context !== null)
        : [],
    [selectedRepos, taskSource]
  )
  const hostRegistryById = useMemo(
    () =>
      new Map(
        buildExecutionHostRegistry({
          repos,
          settings,
          sshTargetLabels,
          sshConnectionStates,
          runtimeEnvironments,
          runtimeStatusByEnvironmentId,
          hostLabelOverrides: getHostDisplayLabelOverrides(settings)
        }).map((host) => [host.id, host])
      ),
    [
      repos,
      settings,
      sshConnectionStates,
      sshTargetLabels,
      runtimeEnvironments,
      runtimeStatusByEnvironmentId
    ]
  )
  const hostLabelById = useMemo(
    () => new Map([...hostRegistryById].map(([hostId, host]) => [hostId, host.label])),
    [hostRegistryById]
  )
  const runtimeTaskSourceHostIds = useMemo(() => {
    if (taskSource !== 'github' && taskSource !== 'gitlab') {
      return []
    }
    const hostIds = new Set<TaskSourceContext['hostId']>()
    for (const context of taskSourceRepoContexts) {
      const parsed = parseExecutionHostId(context.hostId)
      if (parsed?.kind !== 'runtime') {
        continue
      }
      const host = hostRegistryById.get(context.hostId)
      if (
        host?.kind !== 'runtime' ||
        host.health !== 'available' ||
        !host.capabilities?.includes(TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY)
      ) {
        continue
      }
      hostIds.add(parsed.id)
    }
    return [...hostIds].sort()
  }, [hostRegistryById, taskSource, taskSourceRepoContexts])
  useEffect(() => {
    const unrequestedHostIds = runtimeTaskSourceHostIds.filter(
      (hostId) => !runtimePreflightRequestedHostIdsRef.current.has(hostId)
    )
    if (unrequestedHostIds.length === 0) {
      return
    }
    setRuntimePreflightStatusByHostId((current) => {
      const next = new Map(current)
      for (const hostId of unrequestedHostIds) {
        next.set(hostId, {
          checked: false,
          status: null
        })
      }
      return next
    })
    for (const hostId of unrequestedHostIds) {
      runtimePreflightRequestedHostIdsRef.current.add(hostId)
      const parsed = parseExecutionHostId(hostId)
      if (parsed?.kind !== 'runtime') {
        continue
      }
      // Why: task sources can span multiple runtime hosts; each runtime owns its own gh/glab install and auth state.
      void callRuntimeRpc<PreflightStatus>(
        {
          kind: 'environment',
          environmentId: parsed.environmentId
        },
        'preflight.check',
        undefined,
        {
          timeoutMs: 15_000
        }
      )
        .then((status) => {
          if (!runtimePreflightMountedRef.current) {
            return
          }
          setRuntimePreflightStatusByHostId((current) => {
            const next = new Map(current)
            next.set(hostId, {
              checked: true,
              status
            })
            return next
          })
        })
        .catch(() => {
          if (!runtimePreflightMountedRef.current) {
            return
          }
          setRuntimePreflightStatusByHostId((current) => {
            const next = new Map(current)
            next.set(hostId, {
              checked: true,
              status: null
            })
            return next
          })
        })
    }
  }, [runtimeTaskSourceHostIds])
  const nextModel = model as typeof model & {
    defaultTaskViewPreset: typeof defaultTaskViewPreset
    initialTaskQuery: typeof initialTaskQuery
    preferredTaskSource: typeof preferredTaskSource
    taskSource: typeof taskSource
    setTaskSource: typeof setTaskSource
    runtimePreflightMountedRef: typeof runtimePreflightMountedRef
    runtimePreflightRequestedHostIdsRef: typeof runtimePreflightRequestedHostIdsRef
    runtimePreflightStatusByHostId: typeof runtimePreflightStatusByHostId
    setRuntimePreflightStatusByHostId: typeof setRuntimePreflightStatusByHostId
    taskSourceRepoContexts: typeof taskSourceRepoContexts
    hostRegistryById: typeof hostRegistryById
    hostLabelById: typeof hostLabelById
    runtimeTaskSourceHostIds: typeof runtimeTaskSourceHostIds
  }
  nextModel.defaultTaskViewPreset = defaultTaskViewPreset
  nextModel.initialTaskQuery = initialTaskQuery
  nextModel.preferredTaskSource = preferredTaskSource
  nextModel.taskSource = taskSource
  nextModel.setTaskSource = setTaskSource
  nextModel.runtimePreflightMountedRef = runtimePreflightMountedRef
  nextModel.runtimePreflightRequestedHostIdsRef = runtimePreflightRequestedHostIdsRef
  nextModel.runtimePreflightStatusByHostId = runtimePreflightStatusByHostId
  nextModel.setRuntimePreflightStatusByHostId = setRuntimePreflightStatusByHostId
  nextModel.taskSourceRepoContexts = taskSourceRepoContexts
  nextModel.hostRegistryById = hostRegistryById
  nextModel.hostLabelById = hostLabelById
  nextModel.runtimeTaskSourceHostIds = runtimeTaskSourceHostIds
  return nextModel
}
export type TaskPageRuntimeHostsModel = ReturnType<typeof useTaskPageRuntimeHosts>
