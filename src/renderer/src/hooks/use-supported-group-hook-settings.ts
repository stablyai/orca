import { useShallow } from 'zustand/react/shallow'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectGroup } from '../../../shared/project-group-types'
import { projectGroupHookOwner } from '../../../shared/workspace-hook-owner'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import {
  PROJECT_GROUP_FOLDER_SETUP_RUNTIME_CAPABILITY,
  PROJECT_GROUP_FOLDER_ARCHIVE_RUNTIME_CAPABILITY
} from '../../../shared/worktree-runtime-capabilities'
import { runtimeEnvironmentSupportsCapabilities } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { useAppStore } from '@/store'
import { subscribeRuntimeHostContactRegained } from '@/runtime/hosts/connections/runtime-host-contact-regained'
import {
  captureRuntimeEnvironmentRequestRevision,
  getRuntimeEnvironmentRevision,
  resolveContinuedRuntimeEnvironmentRevision
} from '@/runtime/rpc/environment-revisions/runtime-environment-revision'

export type ProjectGroupHookSupport = {
  setup: boolean
  archive: boolean
  pending: boolean
}

export type ProjectGroupSettingsEntry = ProjectGroup & {
  settingsLabel?: string
  supportsArchiveHooks?: boolean
  hookSupport?: ProjectGroupHookSupport
}

export function useSupportedGroupHookSettings(): readonly ProjectGroupSettingsEntry[] {
  const groups = useAppStore((state) => state.projectGroups)
  const labels = useAppStore(
    useShallow((state) =>
      groups.map(
        (group) =>
          `${group.name} (${selectExecutionHostDisplayLabel(state, getRepoExecutionHostId(group))})`
      )
    )
  )
  const [supportedHosts, setSupportedHosts] = useState<
    ReadonlyMap<string, ProjectGroupHookSupport>
  >(new Map())
  const observations = useRef(
    new Map<string, { request: number; queued: boolean; unsubscribe: () => void }>()
  )
  const hosts = useShallow((entries: readonly ProjectGroup[]) => {
    const owners = new Set<string>()
    for (const group of entries) {
      if (projectGroupHookOwner(group)) {
        owners.add(getRepoExecutionHostId(group))
      }
    }
    return [...owners].sort()
  })(groups)
  useEffect(() => {
    const active = observations.current
    const owners = new Set(hosts)
    for (const [host, observation] of active) {
      if (!owners.has(host)) {
        observation.unsubscribe()
        active.delete(host)
      }
    }
    setSupportedHosts((previous) =>
      [...previous.keys()].some((host) => !owners.has(host))
        ? new Map([...previous].filter(([host]) => owners.has(host)))
        : previous
    )
    for (const host of hosts) {
      const parsed = parseExecutionHostId(host)
      if (parsed?.kind !== 'runtime' || active.has(host)) {
        continue
      }
      const environmentId = parsed.environmentId
      const observation = { request: 0, queued: false, unsubscribe: () => {} }
      active.set(host, observation)
      const refresh = (): void => {
        observation.request++
        setSupportedHosts((previous) => {
          const support = previous.get(host)
          return active.get(host) === observation && support && !support.pending
            ? new Map(previous).set(host, { ...support, pending: true })
            : previous
        })
        if (observation.queued) {
          return
        }
        observation.queued = true
        queueMicrotask(async () => {
          observation.queued = false
          if (active.get(host) !== observation) {
            return
          }
          const request = observation.request
          const revision = captureRuntimeEnvironmentRequestRevision(environmentId)
          const current = (): boolean => {
            const actualRevision = getRuntimeEnvironmentRevision(environmentId)
            return (
              active.get(host) === observation &&
              observation.request === request &&
              (revision === undefined
                ? actualRevision === undefined
                : resolveContinuedRuntimeEnvironmentRevision(environmentId, revision) ===
                  actualRevision)
            )
          }
          try {
            const [setup, archive] = await runtimeEnvironmentSupportsCapabilities(environmentId, [
              PROJECT_GROUP_FOLDER_SETUP_RUNTIME_CAPABILITY,
              PROJECT_GROUP_FOLDER_ARCHIVE_RUNTIME_CAPABILITY
            ])
            setSupportedHosts((previous) =>
              current() ? new Map(previous).set(host, { setup, archive, pending: false }) : previous
            )
          } catch {
            // Keep an existing editor mounted but disabled until the host's next lifecycle wake.
          }
        })
      }
      observation.unsubscribe = subscribeRuntimeHostContactRegained(environmentId, refresh)
      refresh()
    }
  }, [hosts])
  useEffect(
    () => () => {
      for (const observation of observations.current.values()) {
        observation.unsubscribe()
      }
      observations.current.clear()
    },
    []
  )
  return useMemo(
    () =>
      groups.flatMap((group, index) => {
        const host = getRepoExecutionHostId(group)
        const support =
          parseExecutionHostId(host)?.kind === 'local'
            ? { setup: true, archive: true, pending: false }
            : supportedHosts.get(host)
        return Boolean(group.parentPath) && support?.setup
          ? [
              {
                ...group,
                settingsLabel: labels[index],
                supportsArchiveHooks: support.archive,
                hookSupport: support
              }
            ]
          : []
      }),
    [groups, supportedHosts, labels]
  )
}
