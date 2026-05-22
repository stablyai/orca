import { useMemo, useState } from 'react'
import { ChevronDown, Pencil, Play, Plus } from 'lucide-react'
import { useAppStore } from '@/store'
import {
  Command,
  CommandEmpty,
  CommandInput,
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
import { getTerminalQuickCommandScope } from '../../../../shared/terminal-quick-commands'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree-id'
import { runQuickCommandInNewTab } from '@/lib/run-quick-command-in-new-tab'
import type { TerminalQuickCommand } from '../../../../shared/types'
import { cn } from '@/lib/utils'

type TabBarQuickCommandsButtonProps = {
  worktreeId: string
  groupId: string
}

function matchesQuery(command: TerminalQuickCommand, query: string): boolean {
  if (!query) {
    return true
  }
  return (
    command.label.toLowerCase().includes(query) || command.command.toLowerCase().includes(query)
  )
}

export function TabBarQuickCommandsButton({
  worktreeId,
  groupId
}: TabBarQuickCommandsButtonProps): React.JSX.Element | null {
  const repoId = useMemo(() => getRepoIdFromWorktreeId(worktreeId), [worktreeId])
  const allCommands = useAppStore((s) => s.settings?.terminalQuickCommands)
  const recentByGroup = useAppStore((s) => s.recentQuickCommandIdByGroup)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const repos = useAppStore((s) => s.repos)

  const { repoCommands, globalCommands } = useMemo(() => {
    const repoList: TerminalQuickCommand[] = []
    const globalList: TerminalQuickCommand[] = []
    for (const command of allCommands ?? []) {
      if (!command.label.trim() || !command.command.trimEnd()) {
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
  const [query, setQuery] = useState('')
  const [commandValue, setCommandValue] = useState('')
  const [editor, setEditor] = useState<
    | { mode: 'add'; command: TerminalQuickCommand }
    | { mode: 'edit'; command: TerminalQuickCommand }
    | null
  >(null)

  const filteredRepo = useMemo(() => {
    const q = query.trim().toLowerCase()
    return repoCommands.filter((c) => matchesQuery(c, q))
  }, [repoCommands, query])

  const filteredGlobal = useMemo(() => {
    const q = query.trim().toLowerCase()
    return globalCommands.filter((c) => matchesQuery(c, q))
  }, [globalCommands, query])

  const totalVisible = filteredRepo.length + filteredGlobal.length
  const hasAnyCommands = repoCommands.length + globalCommands.length > 0

  const handleOpenChange = (next: boolean): void => {
    setMenuOpen(next)
    if (!next) {
      setQuery('')
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
              aria-label="Add quick command"
            >
              <Plus className="size-3.5" />
              <span className="text-[12px] font-medium">Add command</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            Save a quick command for this repo
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
    'my-auto flex h-7 shrink-0 items-stretch rounded-md text-muted-foreground'
  const innerButtonBase =
    'flex items-center bg-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'

  const renderItem = (command: TerminalQuickCommand): React.JSX.Element => (
    <CommandItem
      key={command.id}
      value={command.id}
      onSelect={() => handleRun(command)}
      className="group/qc mx-1 my-0.5 items-center gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 data-[selected=true]:bg-black/8 dark:data-[selected=true]:bg-white/14"
    >
      <Play className="size-3 shrink-0 text-muted-foreground" fill="currentColor" strokeWidth={0} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">{command.label}</span>
        <span className="block truncate font-mono text-[11px] text-muted-foreground">
          {command.command}
        </span>
      </span>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          setMenuOpen(false)
          setEditor({ mode: 'edit', command })
        }}
        className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/qc:opacity-100 group-data-[selected=true]/qc:opacity-100"
        aria-label={`Edit ${command.label}`}
      >
        <Pencil className="size-3" />
      </button>
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
                mostRecent ? `Run quick command: ${mostRecent.label}` : 'Run quick command'
              }
            >
              <Play className="size-3 shrink-0" fill="currentColor" strokeWidth={0} />
              <span className="max-w-[160px] truncate text-[12px] font-medium">
                {mostRecent?.label ?? 'Run'}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {mostRecent ? `Run: ${mostRecent.command}` : 'Run quick command'}
          </TooltipContent>
        </Tooltip>
        <DropdownMenu modal={false} open={menuOpen} onOpenChange={handleOpenChange}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(innerButtonBase, 'justify-center rounded-l-none rounded-r-md px-1')}
              aria-label="More quick commands"
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
              <CommandInput
                autoFocus
                placeholder="Filter commands..."
                value={query}
                onValueChange={setQuery}
                onKeyDown={(event) => event.stopPropagation()}
                className="h-8 py-2 text-xs"
                wrapperClassName="m-1 rounded-[7px] border border-border/70 px-2"
                iconClassName="h-3.5 w-3.5"
              />
              <CommandList className="max-h-72 py-1">
                {totalVisible === 0 ? (
                  <CommandEmpty className="py-4 text-center text-[11px]">
                    No commands match
                  </CommandEmpty>
                ) : null}
                {filteredRepo.map(renderItem)}
                {filteredRepo.length > 0 && filteredGlobal.length > 0 ? (
                  <CommandSeparator className="my-1" />
                ) : null}
                {filteredGlobal.map(renderItem)}
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
                  Add command
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
