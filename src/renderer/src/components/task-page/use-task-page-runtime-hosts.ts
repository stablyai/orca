import { useTranslate } from '@/i18n/use-translate'
import { translateHostDisplayLabel } from '@/runtime/hosts/display/execution-host-label'
import type { TaskPageRepoSelectionModel } from './use-task-page-repo-selection'
import { resolveGitHubLandingPreset } from '../../../../shared/work-items/task-github-search'
import { useAppStore } from '@/store'
import { getTaskPresetQuery } from '../../../../shared/work-items/task-preset-query'
import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import {
  type TaskProvider,
  resolveVisibleTaskProvider
} from '../../../../shared/work-items/task-providers'
import type { TaskSourceContext } from '../../../../shared/work-items/task-source-context'
import type { RuntimeProviderPreflightStatus } from '@/components/task-page/source-selection/task-source-provider-availability'
import { buildExecutionHostRegistry } from '../../../../shared/execution-host/execution-host-registry'
import { getHostDisplayLabelOverrides } from '../../../../shared/execution-host/host-setting-overrides'
import { parseExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { TASK_SOURCE_CONTEXT_RUNTIME_CAPABILITY } from '../../../../shared/work-items/task-source-runtime-capabilities'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { PreflightStatus } from '../../../../preload/api/preflight/preflight-api'
import { getTaskPageRepoSourceContext } from '../../lib/work-items/task-repo-source-context'
export function useTaskPageRuntimeHosts(model: TaskPageRepoSelectionModel) {
  const t = useTranslate()
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
  // Seed preset/query synchronously to avoid a throwaway initial empty-query request.
  const savedGithubPreset = useAppStore((s) => s.taskResumeState?.githubItemsPreset)
  const defaultTaskViewPreset = resolveGitHubLandingPreset(
    savedGithubPreset,
    settings?.defaultTaskViewPreset
  )
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
    () =>
      new Map(
        [...hostRegistryById].map(([hostId, host]) => [hostId, translateHostDisplayLabel(host, t)])
      ),
    [hostRegistryById, t]
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
  const refreshRuntimePreflightHosts = useCallback(
    async (hostIds: readonly TaskSourceContext['hostId'][]): Promise<void> => {
      await Promise.all(
        hostIds.map(async (hostId) => {
          const parsed = parseExecutionHostId(hostId)
          if (parsed?.kind !== 'runtime') {
            return
          }
          setRuntimePreflightStatusByHostId((current) => {
            const next = new Map(current)
            next.set(hostId, { checked: false, status: null })
            return next
          })
          try {
            const status = await callRuntimeRpc<PreflightStatus>(
              { kind: 'environment', environmentId: parsed.environmentId },
              'preflight.check',
              { force: true },
              { timeoutMs: 15_000 }
            )
            if (!runtimePreflightMountedRef.current) {
              return
            }
            setRuntimePreflightStatusByHostId((current) => {
              const next = new Map(current)
              next.set(hostId, { checked: true, status })
              return next
            })
          } catch {
            if (!runtimePreflightMountedRef.current) {
              return
            }
            setRuntimePreflightStatusByHostId((current) => {
              const next = new Map(current)
              next.set(hostId, { checked: true, status: null })
              return next
            })
          }
        })
      )
    },
    []
  )
  return Object.assign(model, {
    defaultTaskViewPreset,
    initialTaskQuery,
    preferredTaskSource,
    taskSource,
    setTaskSource,
    runtimePreflightMountedRef,
    runtimePreflightRequestedHostIdsRef,
    runtimePreflightStatusByHostId,
    setRuntimePreflightStatusByHostId,
    taskSourceRepoContexts,
    hostRegistryById,
    hostLabelById,
    runtimeTaskSourceHostIds,
    refreshRuntimePreflightHosts
  })
}
export type TaskPageRuntimeHostsModel = ReturnType<typeof useTaskPageRuntimeHosts>
