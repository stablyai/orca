import { useShallow } from 'zustand/react/shallow'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { useEffect, useMemo, useState } from 'react'
import type { ProjectGroup } from '../../../shared/project-group-types'
import { projectGroupHookOwner } from '../../../shared/workspace-hook-owner'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import {
  PROJECT_GROUP_FOLDER_SETUP_RUNTIME_CAPABILITY,
  PROJECT_GROUP_FOLDER_ARCHIVE_RUNTIME_CAPABILITY
} from '../../../shared/worktree-runtime-capabilities'
import { runtimeEnvironmentSupportsCapabilities } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { useAppStore } from '@/store'

export type ProjectGroupSettingsEntry = ProjectGroup & {
  settingsLabel?: string
  supportsArchiveHooks?: boolean
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
  const [supportedHosts, setSupportedHosts] = useState<ReadonlyMap<string, boolean>>(new Map())
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
    let cancelled = false
    void Promise.all(
      hosts.map(async (host) => {
        try {
          const parsed = parseExecutionHostId(host)
          if (parsed?.kind !== 'runtime') {
            return parsed?.kind === 'local' ? ([host, true] as const) : null
          }
          const [setup, archive] = await runtimeEnvironmentSupportsCapabilities(
            parsed.environmentId,
            [
              PROJECT_GROUP_FOLDER_SETUP_RUNTIME_CAPABILITY,
              PROJECT_GROUP_FOLDER_ARCHIVE_RUNTIME_CAPABILITY
            ]
          )
          return setup ? ([host, archive] as const) : null
        } catch {
          return null
        }
      })
    ).then((answers) => {
      if (!cancelled) {
        setSupportedHosts(new Map(answers.filter((answer) => answer !== null)))
      }
    })
    return () => {
      cancelled = true
    }
  }, [hosts])
  return useMemo(
    () =>
      groups.flatMap((group, index) => {
        const host = getRepoExecutionHostId(group)
        return Boolean(group.parentPath) &&
          (parseExecutionHostId(host)?.kind === 'local' || supportedHosts.has(host))
          ? [
              {
                ...group,
                settingsLabel: labels[index],
                supportsArchiveHooks:
                  parseExecutionHostId(host)?.kind === 'local' || supportedHosts.get(host) === true
              }
            ]
          : []
      }),
    [groups, supportedHosts, labels]
  )
}
