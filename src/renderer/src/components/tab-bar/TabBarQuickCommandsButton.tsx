import { useCallback, useMemo, useState } from 'react'
import { Play } from 'lucide-react'
import { useAppStore } from '@/store/index'
import { getTerminalQuickCommandHostPromptMaxLength } from '@/lib/terminal/quick-commands/terminal-quick-command-host-prompt-limit'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  createTerminalQuickCommandDraft,
  TerminalQuickCommandDialog
} from '@/components/terminal-quick-commands/TerminalQuickCommandDialog'
import {
  getTerminalQuickCommandScope,
  isTerminalQuickCommandComplete
} from '../../../../shared/terminal/quick-commands/terminal-quick-commands'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { runQuickCommandInNewTab } from '@/lib/terminal/quick-commands/run-quick-command-in-new-tab'
import type { TerminalQuickCommand } from '../../../../shared/terminal/quick-commands/terminal-quick-command-types'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { useTranslate } from '@/i18n/use-translate'
import { TabBarQuickCommandsMenu } from './TabBarQuickCommandsMenu'
import {
  flattenTerminalQuickCommandHosts,
  type HostedTerminalQuickCommand,
  useTerminalQuickCommandHosts
} from '@/hooks/use-terminal-quick-command-hosts'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { useProjectHostSetupProjection } from '@/store/projects/use-project-host-setup-projection'
import { terminalQuickCommandMatchesWorkspaceProject } from '@/lib/terminal/quick-commands/terminal-quick-command-project-scope'
import { useCloudSuggestedRunCommands } from '@/hooks/use-cloud-suggested-run-commands'
import { isOrcaCloudRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/orca-cloud-environment-name'

type TabBarQuickCommandsButtonProps = {
  worktreeId: string
  groupId: string
  isFocused: boolean
}

export function TabBarQuickCommandsButton({
  worktreeId,
  groupId,
  isFocused
}: TabBarQuickCommandsButtonProps): React.JSX.Element | null {
  const t = useTranslate()
  const recentByGroup = useAppStore((s) => s.recentQuickCommandIdByGroup)
  const repos = useAppStore((s) => s.repos)
  const projectHostSetupProjection = useProjectHostSetupProjection()
  const { executionHostId, hosts, refreshRemoteHost, remoteHostLoadFailed, remoteHostPending } =
    useTerminalQuickCommandHosts(worktreeId)
  const confirm = useConfirmationDialog()
  // A cloud workspace's only host is its sandbox; its package.json scripts are suggested there.
  const cloudEnvironmentId = useAppStore((state) => {
    const parsed = parseExecutionHostId(executionHostId)
    if (parsed?.kind !== 'runtime') {
      return null
    }
    const environment = state.runtimeEnvironments.find((e) => e.id === parsed.environmentId)
    return environment && isOrcaCloudRuntimeEnvironment(environment) ? environment.id : null
  })
  const cloudHost =
    cloudEnvironmentId && hosts.length === 1 && hosts[0].hostId === executionHostId
      ? { hostId: hosts[0].hostId, label: hosts[0].label, environmentId: cloudEnvironmentId }
      : null
  const { commands: suggestedCommands, refresh: refreshSuggestions } = useCloudSuggestedRunCommands(
    worktreeId,
    cloudHost
  )
  const handleMenuOpen = useCallback((): void => {
    refreshRemoteHost()
    refreshSuggestions()
  }, [refreshRemoteHost, refreshSuggestions])
  // Floating terminals have a synthetic workspace ID without a repo; never treat that sentinel as a run target.
  const repoId = useMemo(() => {
    if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
      return null
    }
    const candidate = getRepoIdFromWorktreeId(worktreeId)
    return repos.some((r) => r.id === candidate) ? candidate : null
  }, [worktreeId, repos])

  const { repoCommands, globalCommands } = useMemo(() => {
    const repoList: HostedTerminalQuickCommand[] = []
    const globalList: HostedTerminalQuickCommand[] = []
    for (const entry of flattenTerminalQuickCommandHosts(hosts)) {
      const { command } = entry
      if (!isTerminalQuickCommandComplete(command)) {
        continue
      }
      const scope = getTerminalQuickCommandScope(command)
      if (scope.type === 'global') {
        globalList.push(entry)
      } else if (
        scope.type === 'repo' &&
        terminalQuickCommandMatchesWorkspaceProject(command, {
          commandHostId: entry.hostId,
          projectHostSetups: projectHostSetupProjection.setups,
          targetHostId: executionHostId,
          targetRepoId: repoId
        })
      ) {
        repoList.push(entry)
      }
    }
    // Suggested scripts the user hasn't already saved as a command (same command line).
    const saved = new Set(
      [...repoList, ...globalList].map((entry) =>
        'command' in entry.command ? entry.command.command.trim() : ''
      )
    )
    for (const entry of suggestedCommands) {
      if ('command' in entry.command && !saved.has(entry.command.command)) {
        repoList.push(entry)
      }
    }
    return { repoCommands: repoList, globalCommands: globalList }
  }, [executionHostId, hosts, projectHostSetupProjection.setups, repoId, suggestedCommands])

  const recentId = recentByGroup[groupId] ?? null
  // Prefer group history across scopes, then the first repo command, then a global command.
  const mostRecent = useMemo(() => {
    if (recentId) {
      const match =
        repoCommands.find((entry) => entry.key === recentId) ??
        globalCommands.find((entry) => entry.key === recentId) ??
        repoCommands.find((entry) => entry.command.id === recentId) ??
        globalCommands.find((entry) => entry.command.id === recentId)
      if (match) {
        return match
      }
    }
    return repoCommands[0] ?? globalCommands[0] ?? null
  }, [repoCommands, globalCommands, recentId])

  const [editor, setEditor] = useState<
    | { mode: 'add'; command: TerminalQuickCommand; hostId: ExecutionHostId }
    | { mode: 'edit'; command: TerminalQuickCommand; hostId: ExecutionHostId }
    | null
  >(null)

  const totalVisible = repoCommands.length + globalCommands.length
  const hasAnyCommands = totalVisible > 0
  const defaultHostId = hosts.some((host) => host.hostId === executionHostId)
    ? executionHostId
    : hosts[0].hostId

  const addRepoCommand = (hostId: ExecutionHostId): void => {
    setEditor({
      mode: 'add',
      hostId,
      command: createTerminalQuickCommandDraft({ type: 'repo', repoId: repoId ?? '' })
    })
  }

  const handleSaveCommand = async (next: TerminalQuickCommand): Promise<boolean> =>
    editor ? await useAppStore.getState().upsertTerminalQuickCommand(editor.hostId, next) : false

  const handleDeleteCommand = async (entry: HostedTerminalQuickCommand): Promise<void> => {
    const { command } = entry
    const confirmed = await confirm({
      title: t(
        'auto.components.tab.bar.TabBarQuickCommandsButton.e8e1a52edb',
        'Delete "{{value0}}"?',
        { value0: command.label }
      ),
      description: t(
        'auto.components.tab.bar.TabBarQuickCommandsButton.3220e2da27',
        'This quick command will be removed from your saved list.'
      ),
      confirmLabel: t('auto.components.tab.bar.TabBarQuickCommandsButton.be8f0ff166', 'Delete'),
      confirmVariant: 'destructive'
    })
    if (!confirmed) {
      return
    }
    void useAppStore.getState().deleteTerminalQuickCommand(entry.hostId, command.id)
  }

  const handleRun = (entry: HostedTerminalQuickCommand): void => {
    runQuickCommandInNewTab({
      command: entry.command,
      worktreeId,
      groupId,
      historyId: entry.key
    })
  }
  const editorPromptMaxLength = useAppStore((state) =>
    editor ? getTerminalQuickCommandHostPromptMaxLength(state, editor.hostId) : undefined
  )
  const editorRepos = editor?.hostId.startsWith('runtime:')
    ? repos.filter((repo) => getRepoExecutionHostId(repo) === editor.hostId)
    : repos

  // Hide without a repo run target, including folder workspaces and floating terminals.
  if (!repoId) {
    return null
  }

  if (!hasAnyCommands && hosts.length === 1 && !remoteHostPending) {
    return (
      <>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => addRepoCommand(defaultHostId)}
              // A package.json added since the last read turns this into the suggestions menu.
              onPointerEnter={refreshSuggestions}
              className="my-auto flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label={t(
                'auto.components.tab.bar.TabBarQuickCommandsButton.8f1e971966',
                'Add quick command'
              )}
            >
              <Play className="size-3.5" />
              <span className="text-[12px] font-medium @max-[480px]/tab-strip:hidden">
                {t('auto.components.tab.bar.TabBarQuickCommandsButton.a2c7a33831', 'Command')}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {t(
              'auto.components.tab.bar.TabBarQuickCommandsButton.1d411fb6a5',
              'Save a quick command for this repo'
            )}
          </TooltipContent>
        </Tooltip>
        <TerminalQuickCommandDialog
          open={editor !== null}
          mode={editor?.mode ?? 'add'}
          command={editor?.command ?? createTerminalQuickCommandDraft({ type: 'repo', repoId })}
          repos={editorRepos}
          agentPromptMaxLength={editorPromptMaxLength}
          onOpenChange={(open) => !open && setEditor(null)}
          onSave={handleSaveCommand}
        />
      </>
    )
  }

  return (
    <>
      <TabBarQuickCommandsMenu
        isFocused={isFocused}
        repoCommands={repoCommands}
        globalCommands={globalCommands}
        mostRecent={mostRecent}
        addHosts={hosts}
        hostLoadFailed={remoteHostLoadFailed}
        hostOwnershipPending={remoteHostPending}
        onMenuOpen={handleMenuOpen}
        onAddCommand={addRepoCommand}
        onEditCommand={(entry) =>
          setEditor({ mode: 'edit', command: entry.command, hostId: entry.hostId })
        }
        onDeleteCommand={(entry) => void handleDeleteCommand(entry)}
        onRunCommand={handleRun}
      />
      <TerminalQuickCommandDialog
        open={editor !== null}
        mode={editor?.mode ?? 'add'}
        command={editor?.command ?? createTerminalQuickCommandDraft({ type: 'repo', repoId })}
        repos={editorRepos}
        agentPromptMaxLength={editorPromptMaxLength}
        onOpenChange={(open) => !open && setEditor(null)}
        onSave={handleSaveCommand}
      />
    </>
  )
}
