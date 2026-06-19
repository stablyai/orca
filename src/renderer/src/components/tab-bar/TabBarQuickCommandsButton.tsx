import { useMemo, useState } from 'react'
import { Play } from 'lucide-react'
import { useAppStore } from '@/store'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  createTerminalQuickCommandDraft,
  TerminalQuickCommandDialog
} from '@/components/terminal-quick-commands/TerminalQuickCommandDialog'
import {
  getTerminalQuickCommandScope,
  isTerminalQuickCommandComplete
} from '../../../../shared/terminal-quick-commands'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree-id'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { runQuickCommandInNewTab } from '@/lib/run-quick-command-in-new-tab'
import type { TerminalQuickCommand } from '../../../../shared/types'
import { useConfirmationDialog } from '@/components/confirmation-dialog'
import { translate } from '@/i18n/i18n'
import { TabBarQuickCommandsMenu } from './TabBarQuickCommandsMenu'

type TabBarQuickCommandsButtonProps = {
  worktreeId: string
  groupId: string
}

export function TabBarQuickCommandsButton({
  worktreeId,
  groupId
}: TabBarQuickCommandsButtonProps): React.JSX.Element | null {
  const allCommands = useAppStore((s) => s.settings?.terminalQuickCommands)
  const recentByGroup = useAppStore((s) => s.recentQuickCommandIdByGroup)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const repos = useAppStore((s) => s.repos)
  const confirm = useConfirmationDialog()
  // Why: floating terminals share a synthetic worktree id (`global-floating-terminal`)
  // that has no separator, so naive `getRepoIdFromWorktreeId` would return that
  // sentinel as a "repo id" and the button would point at a repo that doesn't
  // exist. Resolve to a real repo from the workspace; otherwise hide the button.
  const repoId = useMemo(() => {
    if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
      return null
    }
    const candidate = getRepoIdFromWorktreeId(worktreeId)
    return repos.some((r) => r.id === candidate) ? candidate : null
  }, [worktreeId, repos])

  const { repoCommands, globalCommands } = useMemo(() => {
    const repoList: TerminalQuickCommand[] = []
    const globalList: TerminalQuickCommand[] = []
    for (const command of allCommands ?? []) {
      if (!isTerminalQuickCommandComplete(command)) {
        continue
      }
      const scope = getTerminalQuickCommandScope(command)
      if (scope.type === 'global') {
        globalList.push(command)
      } else if (scope.type === 'repo' && repoId !== null && scope.repoId === repoId) {
        repoList.push(command)
      }
    }
    return { repoCommands: repoList, globalCommands: globalList }
  }, [allCommands, repoId])

  const recentId = recentByGroup[groupId] ?? null
  // Why: split-button label prefers the most recently used command for this
  // group regardless of scope, then falls back to the first repo command (so
  // repo-scoped is preferred over global on first run), then to the first
  // global one if no repo commands exist.
  const mostRecent = useMemo(() => {
    if (recentId) {
      const match =
        repoCommands.find((c) => c.id === recentId) ?? globalCommands.find((c) => c.id === recentId)
      if (match) {
        return match
      }
    }
    return repoCommands[0] ?? globalCommands[0] ?? null
  }, [repoCommands, globalCommands, recentId])

  const [editor, setEditor] = useState<
    | { mode: 'add'; command: TerminalQuickCommand }
    | { mode: 'edit'; command: TerminalQuickCommand }
    | null
  >(null)

  const totalVisible = repoCommands.length + globalCommands.length
  const hasAnyCommands = totalVisible > 0

  const addRepoCommand = (): void => {
    setEditor({
      mode: 'add',
      command: createTerminalQuickCommandDraft({ type: 'repo', repoId: repoId ?? '' })
    })
  }

  const handleSaveCommand = (next: TerminalQuickCommand): void => {
    const current = useAppStore.getState().settings?.terminalQuickCommands ?? []
    const isEdit = current.some((c) => c.id === next.id)
    const nextList = isEdit ? current.map((c) => (c.id === next.id ? next : c)) : [...current, next]
    void updateSettings({ terminalQuickCommands: nextList })
  }

  const handleDeleteCommand = async (command: TerminalQuickCommand): Promise<void> => {
    const confirmed = await confirm({
      title: translate(
        'auto.components.tab.bar.TabBarQuickCommandsButton.e8e1a52edb',
        'Delete "{{value0}}"?',
        { value0: command.label }
      ),
      description: translate(
        'auto.components.tab.bar.TabBarQuickCommandsButton.3220e2da27',
        'This quick command will be removed from your saved list.'
      ),
      confirmLabel: translate(
        'auto.components.tab.bar.TabBarQuickCommandsButton.be8f0ff166',
        'Delete'
      ),
      confirmVariant: 'destructive'
    })
    if (!confirmed) {
      return
    }
    const current = useAppStore.getState().settings?.terminalQuickCommands ?? []
    void updateSettings({ terminalQuickCommands: current.filter((c) => c.id !== command.id) })
  }

  const handleRun = (command: TerminalQuickCommand): void => {
    runQuickCommandInNewTab({ command, worktreeId, groupId })
  }

  // Why: hidden in folder-mode worktrees (no repoId) and floating terminals.
  // Without a repoId the button can't represent a repo-scoped run target, and
  // global-only mode would be confusing in a context that doesn't belong to a
  // repo at all.
  if (!repoId) {
    return null
  }

  // Empty state: single "+ Command" button that opens the dialog directly.
  if (!hasAnyCommands) {
    return (
      <>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={addRepoCommand}
              className="my-auto flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label={translate(
                'auto.components.tab.bar.TabBarQuickCommandsButton.8f1e971966',
                'Add quick command'
              )}
            >
              <Play className="size-3.5" />
              <span className="text-[12px] font-medium">
                {translate(
                  'auto.components.tab.bar.TabBarQuickCommandsButton.a2c7a33831',
                  'Command'
                )}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate(
              'auto.components.tab.bar.TabBarQuickCommandsButton.1d411fb6a5',
              'Save a quick command for this repo'
            )}
          </TooltipContent>
        </Tooltip>
        <TerminalQuickCommandDialog
          open={editor !== null}
          mode={editor?.mode ?? 'add'}
          command={editor?.command ?? createTerminalQuickCommandDraft({ type: 'repo', repoId })}
          repos={repos}
          onOpenChange={(open) => !open && setEditor(null)}
          onSave={handleSaveCommand}
        />
      </>
    )
  }

  return (
    <>
      <TabBarQuickCommandsMenu
        repoCommands={repoCommands}
        globalCommands={globalCommands}
        mostRecent={mostRecent}
        onAddCommand={addRepoCommand}
        onEditCommand={(command) => setEditor({ mode: 'edit', command })}
        onDeleteCommand={(command) => void handleDeleteCommand(command)}
        onRunCommand={handleRun}
      />
      <TerminalQuickCommandDialog
        open={editor !== null}
        mode={editor?.mode ?? 'add'}
        command={editor?.command ?? createTerminalQuickCommandDraft({ type: 'repo', repoId })}
        repos={repos}
        onOpenChange={(open) => !open && setEditor(null)}
        onSave={handleSaveCommand}
      />
    </>
  )
}
