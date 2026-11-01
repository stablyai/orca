import React, { useMemo } from 'react'
import { Cloud, Monitor, Server } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { translate } from '@/i18n/i18n'
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { getComposerEligibleRepos } from '@/lib/new-workspace-composer-repo'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { buildExecutionHostRegistry } from '../../../../shared/execution-host-registry'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import { useAppStore } from '../../store'
import { selectKnownWorktreeById } from '@/store/selectors'
import { getProjectHostSetupProjectionFromState } from '@/store/project-host-setup-selector'
import {
  buildProjectHostSetupOptions,
  type ReadyProjectHostSetupOption
} from '@/lib/project-host-setup-options'
import {
  getWorktreeProjectId,
  isWorktreeOwnHost,
  isLocalHostTerminalSource
} from './tab-bar-host-terminal-targets'

export function useHostTerminalRows(worktreeId: string) {
  const worktree = useAppStore(
    useShallow((state) => {
      const row = selectKnownWorktreeById(state, worktreeId)
      return row
        ? {
            repoId: row.repoId,
            projectId: row.projectId,
            hostId: row.hostId,
            runtimeOwnerEnvironmentId: row.runtimeOwnerEnvironmentId
          }
        : null
    })
  )
  const sourceIsLocal = useAppStore((state) => isLocalHostTerminalSource(state, worktreeId))
  const repos = useAppStore((state) => state.repos)
  const projection = useAppStore(getProjectHostSetupProjectionFromState)
  const settings = useAppStore((state) => state.settings)
  const sshTargetLabels = useAppStore((state) => state.sshTargetLabels)
  const sshConnectionStates = useAppStore((state) => state.sshConnectionStates)
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useAppStore((state) => state.runtimeStatusByEnvironmentId)
  return useMemo(() => {
    if (!worktree || !sourceIsLocal) {
      return []
    }
    const repo = repos.find((candidate) => candidate.id === worktree.repoId)
    const hosts = buildExecutionHostRegistry({
      repos,
      settings,
      hostSource: 'configured-only',
      sshTargetLabels,
      sshConnectionStates,
      runtimeEnvironments,
      runtimeStatusByEnvironmentId,
      hostLabelOverrides: getHostDisplayLabelOverrides(settings)
    })
    return buildProjectHostSetupOptions({
      projectId: getWorktreeProjectId(worktree, repo, projection.setups),
      projectHostSetups: projection.setups,
      eligibleRepos: getComposerEligibleRepos(repos),
      hosts
    })
      .filter((option) => parseExecutionHostId(option.hostId)?.kind !== 'ssh')
      .map((option) => ({ option, isOwnHost: isWorktreeOwnHost(option.hostId, worktree, repo) }))
      .sort((a, b) => Number(b.isOwnHost) - Number(a.isOwnHost))
  }, [
    worktree,
    sourceIsLocal,
    repos,
    projection,
    settings,
    sshTargetLabels,
    sshConnectionStates,
    runtimeEnvironments,
    runtimeStatusByEnvironmentId
  ])
}

export function TabBarHostTerminalSubmenu({
  worktreeId,
  onNewTerminalTab,
  onNewHostTerminal
}: {
  worktreeId: string
  onNewTerminalTab: () => void
  onNewHostTerminal: (option: ReadyProjectHostSetupOption) => void
}): React.JSX.Element | null {
  const rows = useHostTerminalRows(worktreeId)
  if (!rows.some((row) => !row.isOwnHost)) {
    return null
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Server className="size-4 text-muted-foreground" />
        <span className="flex-1">
          {translate('auto.components.tab.bar.TabBar.7c1313d237', 'New Terminal:')}{' '}
          {translate('auto.components.settings.SettingsHostScopePicker.label', 'Host')}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-72 max-w-[calc(100vw-1rem)]">
        {rows.map(({ option, isOwnHost }) => {
          const Icon = parseExecutionHostId(option.hostId)?.kind === 'runtime' ? Cloud : Monitor
          return (
            <DropdownMenuItem
              key={option.id}
              disabled={option.kind !== 'ready'}
              data-host-terminal-target={option.hostId}
              onSelect={() => {
                if (isOwnHost) {
                  onNewTerminalTab()
                } else if (option.kind === 'ready') {
                  onNewHostTerminal(option)
                }
              }}
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{option.label}</span>
                <span className="truncate text-2xs font-normal text-muted-foreground">
                  {option.kind === 'ready' ? option.path : option.detail}
                </span>
              </span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
