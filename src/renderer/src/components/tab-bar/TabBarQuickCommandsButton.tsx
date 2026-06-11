import { useMemo, useState } from 'react'
import { ChevronDown, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { useAppStore } from '@/store'
import {
  Command,
  CommandEmpty,
  CommandItem,
  CommandList,
  CommandSeparator
} from '@/components/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  createTerminalQuickCommandDraft,
  TerminalQuickCommandDialog
} from '@/components/terminal-quick-commands/TerminalQuickCommandDialog'
import {
  getTerminalQuickCommandBody,
  getTerminalQuickCommandScope,
  isTerminalAgentQuickCommand,
  isTerminalQuickCommandComplete
} from '../../../../shared/terminal-quick-commands'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree-id'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { runQuickCommandInNewTab } from '@/lib/run-quick-command-in-new-tab'
import type { TerminalQuickCommand } from '../../../../shared/types'
import { cn } from '@/lib/utils'
import { useConfirmationDialog } from '@/components/confirmation-dialog'
import { AgentIcon, getAgentLabel } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'

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

  const [menuOpen, setMenuOpen] = useState(false)
  const [commandValue, setCommandValue] = useState('')
  const [editor, setEditor] = useState<
    | { mode: 'add'; command: TerminalQuickCommand }
    | { mode: 'edit'; command: TerminalQuickCommand }
    | null
  >(null)

  const totalVisible = repoCommands.length + globalCommands.length
  const hasAnyCommands = totalVisible > 0

  const handleOpenChange = (next: boolean): void => {
    setMenuOpen(next)
    if (!next) {
      setCommandValue('')
    }
  }

  const handleRun = (command: TerminalQuickCommand): void => {
    setMenuOpen(false)
    runQuickCommandInNewTab({ command, worktreeId, groupId })
  }

  const handleSaveCommand = (next: TerminalQuickCommand): void => {
    const current = useAppStore.getState().settings?.terminalQuickCommands ?? []
    const isEdit = current.some((c) => c.id === next.id)
    const nextList = isEdit ? current.map((c) => (c.id === next.id ? next : c)) : [...current, next]
    void updateSettings({ terminalQuickCommands: nextList })
  }

  const handleDeleteCommand = async (command: TerminalQuickCommand): Promise<void> => {
    setMenuOpen(false)
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

  // Why: hidden in folder-mode worktrees (no repoId) and floating terminals.
  // Without a repoId the button can't represent a repo-scoped run target, and
  // global-only mode would be confusing in a context that doesn't belong to a
  // repo at all.
  if (!repoId) {
    return null
  }

  // Empty state: single "Add command" button that opens the dialog directly.
  if (!hasAnyCommands) {
    return (
      <>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() =>
                setEditor({
                  mode: 'add',
                  command: createTerminalQuickCommandDraft({ type: 'repo', repoId })
                })
              }
              className="my-auto flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label={translate(
                'auto.components.tab.bar.TabBarQuickCommandsButton.8f1e971966',
                'Add quick command'
              )}
            >
              <Plus className="size-3.5" />
              <span className="text-[12px] font-medium">
                {translate(
                  'auto.components.tab.bar.TabBarQuickCommandsButton.a2c7a33831',
                  'Add command'
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

  const splitButtonClass =
    'my-auto flex h-7 shrink-0 items-stretch overflow-hidden rounded-md border border-border/60 text-muted-foreground'
  const innerButtonBase =
    'flex items-center bg-transparent leading-none text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'

  const renderItem = (command: TerminalQuickCommand): React.JSX.Element => (
    <CommandItem
      key={command.id}
      value={command.id}
      onSelect={() => handleRun(command)}
      className="group/qc mx-1 my-0.5 items-center gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 data-[selected=true]:bg-black/8 dark:data-[selected=true]:bg-white/14"
    >
      {isTerminalAgentQuickCommand(command) ? (
        <span className="shrink-0 text-muted-foreground">
          <AgentIcon agent={command.agent} size={12} />
        </span>
      ) : (
        <Play
          className="size-3 shrink-0 text-muted-foreground"
          fill="currentColor"
          strokeWidth={0}
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">{command.label}</span>
        <span className="block truncate font-mono text-[11px] text-muted-foreground">
          {isTerminalAgentQuickCommand(command)
            ? `${getAgentLabel(command.agent)}: ${command.prompt}`
            : command.command}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/qc:opacity-100 group-data-[selected=true]/qc:opacity-100">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            setMenuOpen(false)
            setEditor({ mode: 'edit', command })
          }}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={translate(
            'auto.components.tab.bar.TabBarQuickCommandsButton.15529ede69',
            'Edit {{value0}}',
            { value0: command.label }
          )}
        >
          <Pencil className="size-3" />
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            void handleDeleteCommand(command)
          }}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
          aria-label={translate(
            'auto.components.tab.bar.TabBarQuickCommandsButton.196593b6a9',
            'Remove {{value0}}',
            { value0: command.label }
          )}
        >
          <Trash2 className="size-3" />
        </button>
      </span>
    </CommandItem>
  )

  return (
    <>
      <div className={splitButtonClass}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => mostRecent && handleRun(mostRecent)}
              disabled={!mostRecent}
              className={cn(innerButtonBase, 'gap-1.5 rounded-l-md rounded-r-none px-1.5')}
              aria-label={
                mostRecent
                  ? translate(
                      'auto.components.tab.bar.TabBarQuickCommandsButton.b775303755',
                      'Run quick command: {{value0}}',
                      { value0: mostRecent.label }
                    )
                  : translate(
                      'auto.components.tab.bar.TabBarQuickCommandsButton.85482c57bc',
                      'Run quick command'
                    )
              }
            >
              <Play className="size-3 shrink-0" fill="currentColor" strokeWidth={0} />
              <span className="max-w-[160px] truncate text-[12px] font-medium">
                {mostRecent?.label ??
                  translate('auto.components.tab.bar.TabBarQuickCommandsButton.7b1c9d6ae1', 'Run')}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {mostRecent
              ? isTerminalAgentQuickCommand(mostRecent)
                ? translate(
                    'auto.components.tab.bar.TabBarQuickCommandsButton.77ac113df0',
                    'Start {{value0}}: {{value1}}',
                    {
                      value0: getAgentLabel(mostRecent.agent),
                      value1: getTerminalQuickCommandBody(mostRecent)
                    }
                  )
                : translate(
                    'auto.components.tab.bar.TabBarQuickCommandsButton.37e1bb90ce',
                    'Run: {{value0}}',
                    { value0: getTerminalQuickCommandBody(mostRecent) }
                  )
              : translate(
                  'auto.components.tab.bar.TabBarQuickCommandsButton.85482c57bc',
                  'Run quick command'
                )}
          </TooltipContent>
        </Tooltip>
        <DropdownMenu modal={false} open={menuOpen} onOpenChange={handleOpenChange}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                innerButtonBase,
                'justify-center rounded-l-none rounded-r-md border-l border-border/60 px-1'
              )}
              aria-label={translate(
                'auto.components.tab.bar.TabBarQuickCommandsButton.b82e237a4b',
                'More quick commands'
              )}
            >
              <ChevronDown className="size-3" strokeWidth={2.5} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="bottom" sideOffset={6} className="w-72 p-0">
            <Command
              shouldFilter={false}
              value={commandValue}
              onValueChange={setCommandValue}
              className="bg-transparent"
            >
              <CommandList className="max-h-72 py-1">
                {totalVisible === 0 ? (
                  <CommandEmpty className="py-4 text-center text-[11px]">
                    {translate(
                      'auto.components.tab.bar.TabBarQuickCommandsButton.20bbd75896',
                      'No commands'
                    )}
                  </CommandEmpty>
                ) : null}
                {repoCommands.map(renderItem)}
                {repoCommands.length > 0 && globalCommands.length > 0 ? (
                  <CommandSeparator className="my-1" />
                ) : null}
                {globalCommands.map(renderItem)}
              </CommandList>
              <div className="border-t border-border/50 p-1">
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false)
                    setEditor({
                      mode: 'add',
                      command: createTerminalQuickCommandDraft({ type: 'repo', repoId })
                    })
                  }}
                  className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <Plus className="size-3.5" />
                  {translate(
                    'auto.components.tab.bar.TabBarQuickCommandsButton.a2c7a33831',
                    'Add command'
                  )}
                </button>
              </div>
            </Command>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
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
