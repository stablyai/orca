import { selectCanonicalProjectHostSetups } from '@/store/project-host-setup-selector'
import React, { useMemo } from 'react'
import { Cloud, Monitor, Server } from 'lucide-react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { translate } from '@/i18n/i18n'
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { getComposerEligibleRepos } from '@/lib/new-workspace-composer-repo'
import { isPositivelyLocalSourceWorktree } from '@/lib/terminal-worktree-route'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { buildExecutionHostRegistry } from '../../../../shared/execution-host-registry'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import { useAppStore } from '../../store'
import { findWorktreeById } from '../../store/slices/worktree-helpers'
import { selectWorktreesByRepo } from '../../store/workspace-record-selectors'
import {
  buildProjectHostSetupOptions,
  type ProjectHostSetupOption
} from '@/lib/project-host-setup-options'
import { getWorktreeProjectId, isWorktreeOwnHost } from './tab-bar-host-terminal-targets'
import { createTerminalTabOnHost } from './tab-bar-host-terminal-create'

type HostTerminalRow = {
  option: ProjectHostSetupOption
  label: string
  detail: string
  disabled: boolean
  isOwnHost: boolean
}

// Why a constant, like the catalog's own row details: no locale key exists for it in S1.
export const LOCAL_SOURCE_ONLY_DETAIL = 'Open cross-host tabs from a local project in this version.'

export function useHostTerminalRows(worktreeId: string): HostTerminalRow[] {
  // Why shallow primitives: worktree objects get a new identity on every poller write.
  const worktree = useAppStore(
    useShallow((s) => {
      const match = findWorktreeById(selectWorktreesByRepo(s), worktreeId)
      return match
        ? {
            repoId: match.repoId,
            projectId: match.projectId,
            hostId: match.hostId,
            runtimeOwnerEnvironmentId: match.runtimeOwnerEnvironmentId
          }
        : null
    })
  )
  const sourceIsLocal = useAppStore((s) => isPositivelyLocalSourceWorktree(s, worktreeId))
  const repos = useAppStore((s) => s.repos)
  const projectHostSetups = useAppStore((s) => selectCanonicalProjectHostSetups(s))
  const settings = useAppStore((s) => s.settings)
  const sshTargetLabels = useAppStore((s) => s.sshTargetLabels)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  return useMemo(() => {
    if (!worktree) {
      return []
    }
    const repo = repos.find((candidate) => candidate.id === worktree.repoId)
    // Why configured-only: the host set the Create-Worktree "Run on" picker offers.
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
      projectId: getWorktreeProjectId(worktree, repo, projectHostSetups),
      projectHostSetups,
      eligibleRepos: getComposerEligibleRepos(repos),
      hosts
    })
      .filter((option) => parseExecutionHostId(option.hostId)?.kind !== 'ssh')
      .map((option) => ({
        option,
        label: option.label,
        detail: sourceIsLocal
          ? option.kind === 'ready'
            ? option.path
            : option.detail
          : LOCAL_SOURCE_ONLY_DETAIL,
        disabled: !sourceIsLocal || option.kind === 'needs-setup',
        isOwnHost: isWorktreeOwnHost(option.hostId, worktree, repo)
      }))
      .sort((a, b) => Number(b.isOwnHost) - Number(a.isOwnHost))
  }, [
    projectHostSetups,
    repos,
    sourceIsLocal,
    runtimeEnvironments,
    runtimeStatusByEnvironmentId,
    settings,
    sshConnectionStates,
    sshTargetLabels,
    worktree
  ])
}

function HostIcon({ row }: { row: HostTerminalRow }): React.JSX.Element {
  const kind = parseExecutionHostId(row.option.hostId)?.kind
  const Icon = kind === 'runtime' ? Cloud : Monitor
  return <Icon className="size-4 shrink-0 text-muted-foreground" />
}

/** Renders nothing when the worktree's own host is the only one, so that "+" menu is unchanged. */
export function TabBarHostTerminalSubmenu({
  worktreeId,
  groupId,
  onNewTerminalTab
}: {
  worktreeId: string
  groupId?: string
  onNewTerminalTab: () => void
}): React.JSX.Element | null {
  const rows = useHostTerminalRows(worktreeId)
  const onSelect = (row: HostTerminalRow) => {
    if (row.isOwnHost) {
      return onNewTerminalTab()
    }
    if (row.option.kind !== 'ready') {
      return
    }
    void createTerminalTabOnHost({
      worktreeId,
      groupId: groupId ?? useAppStore.getState().activeGroupIdByWorktree[worktreeId] ?? worktreeId,
      executionHostId: row.option.hostId,
      projectHostSetupId: row.option.id
    }).then((result) => {
      if (result.status !== 'refused') {
        return
      }
      const { refusal } = result
      const reason = refusal.runtimeCode ? `${refusal.code}: ${refusal.runtimeCode}` : refusal.code
      toast.error(
        translate(
          'auto.lib.launch.agent.in.new.tab.11cce5cc77',
          'Could not launch {{value0}} in a new terminal.',
          { value0: row.label }
        ),
        { description: reason }
      )
    })
  }
  if (!rows.some((row) => !row.isOwnHost)) {
    return null
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Server className="size-4 text-muted-foreground" />
        {/* Why existing keys: reads like the "New Terminal: <shell>" rows beside it. */}
        <span className="flex-1">
          {translate('auto.components.tab.bar.TabBar.7c1313d237', 'New Terminal:')}{' '}
          {translate('auto.components.settings.SettingsHostScopePicker.label', 'Host')}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-72 max-w-[calc(100vw-1rem)]">
        {rows.map((row) => {
          return (
            <DropdownMenuItem
              key={row.option.id}
              data-host-terminal-target={row.option.hostId}
              disabled={row.disabled}
              onSelect={() => onSelect(row)}
            >
              <HostIcon row={row} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{row.label}</span>
                <span className="truncate text-2xs font-normal text-muted-foreground">
                  {row.detail}
                </span>
              </span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
