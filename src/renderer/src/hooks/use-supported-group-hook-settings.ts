import { useShallow } from 'zustand/react/shallow'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { useEffect, useMemo, useState } from 'react'
import type { ProjectGroup } from '../../../shared/project-group-types'
import { projectGroupHookOwner } from '../../../shared/workspace-hook-owner'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import { PROJECT_GROUP_FOLDER_SETUP_RUNTIME_CAPABILITY } from '../../../shared/worktree-runtime-capabilities'
import { resolveFolderSetupSupported } from '@/lib/workspace/creation/setup/folder-setup-support'
import { useAppStore } from '@/store'

export type ProjectGroupSettingsEntry = ProjectGroup & { settingsLabel?: string }

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
  const [supportedHosts, setSupportedHosts] = useState<ReadonlySet<string>>(new Set())
  const hosts = useMemo(() => {
    const owners = new Map<string, NonNullable<ReturnType<typeof projectGroupHookOwner>>>()
    for (const group of groups) {
      const owner = projectGroupHookOwner(group)
      if (owner) {
        owners.set(getRepoExecutionHostId(group), owner)
      }
    }
    return [...owners]
  }, [groups])
  useEffect(() => {
    let cancelled = false
    void Promise.all(
      hosts.map(async ([host, owner]) => {
        try {
          return (await resolveFolderSetupSupported(
            owner,
            PROJECT_GROUP_FOLDER_SETUP_RUNTIME_CAPABILITY
          ))
            ? host
            : null
        } catch {
          return null
        }
      })
    ).then((answers) => {
      if (!cancelled) {
        setSupportedHosts(new Set(answers.filter((host): host is string => host !== null)))
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
          ? [{ ...group, settingsLabel: labels[index] }]
          : []
      }),
    [groups, supportedHosts, labels]
  )
}
