import { useCallback, useMemo, useRef, useState } from 'react'
import { Check, ChevronsUpDown, Pencil, Plus, Trash2 } from 'lucide-react'
import type {
  GlobalSettings,
  Repo,
  TerminalQuickCommand,
  TerminalQuickCommandScope
} from '../../../../shared/types'
import {
  getTerminalQuickCommandBody,
  getTerminalQuickCommandScope,
  isTerminalAgentQuickCommand
} from '../../../../shared/terminal-quick-commands'
import {
  createTerminalQuickCommandDraft,
  TerminalQuickCommandDialog
} from '@/components/terminal-quick-commands/TerminalQuickCommandDialog'
import { useAppStore } from '../../store'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Command, CommandItem, CommandList } from '../ui/command'
import { Label } from '../ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import RepoBadgeLabel, { RepoBadgeMark } from '../repo/RepoBadgeLabel'
import { cn } from '@/lib/utils'
import { useConfirmationDialog } from '@/components/confirmation-dialog'
import { AgentIcon, getAgentLabel } from '@/lib/agent-catalog'

type QuickCommandsPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  addCommandIntentSignal?: number
}

const GLOBAL_SCOPE_KEY = '__global__'

type EditorState =
  | {
      mode: 'add'
      command: TerminalQuickCommand
    }
  | {
      mode: 'edit'
      command: TerminalQuickCommand
    }
  | null

function getRepoLabel(repo: Pick<Repo, 'displayName' | 'path'>): string {
  return repo.displayName || repo.path
}

export function shouldOpenQuickCommandAddIntent(
  addCommandIntentSignal: number | undefined,
  consumedAddIntentSignal: number
): boolean {
  return Boolean(addCommandIntentSignal && consumedAddIntentSignal !== addCommandIntentSignal)
}

function getScopeLabel(
  scope: TerminalQuickCommandScope,
  repoById: Map<string, Pick<Repo, 'displayName' | 'path' | 'badgeColor'>>
): string {
  if (scope.type === 'global') {
    return 'Global'
  }
  const repo = repoById.get(scope.repoId)
  return repo ? getRepoLabel(repo) : 'Missing project'
}

export function QuickCommandsPane({
  settings,
  updateSettings,
  addCommandIntentSignal
}: QuickCommandsPaneProps): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const commands = settings.terminalQuickCommands ?? []
  const confirm = useConfirmationDialog()

  const [editor, setEditor] = useState<EditorState>(null)
  const consumedAddIntentSignalRef = useRef(0)
  // Why: `null` means "show all" (sticky-all), independent of the current repo
  // list — mirrors the tasks-page repo combobox so newly added repos appear
  // automatically rather than being silently excluded.
  const [scopeSelection, setScopeSelection] = useState<ReadonlySet<string> | null>(null)
  const [scopePopoverOpen, setScopePopoverOpen] = useState(false)

  const repoById = useMemo(() => new Map(repos.map((repo) => [repo.id, repo])), [repos])

  const allScopeKeys = useMemo(
    () => new Set<string>([GLOBAL_SCOPE_KEY, ...repos.map((r) => r.id)]),
    [repos]
  )
  const effectiveSelection: ReadonlySet<string> = scopeSelection ?? allScopeKeys
  const showAll = scopeSelection === null

  const visibleCommands = commands.filter((command) => {
    const scope = getTerminalQuickCommandScope(command)
    if (showAll) {
      return true
    }
    if (scope.type === 'global') {
      return effectiveSelection.has(GLOBAL_SCOPE_KEY)
    }
    return effectiveSelection.has(scope.repoId)
  })

  const createDraftForCurrentFilter = useCallback((): TerminalQuickCommand => {
    // Why: when the user has narrowed to a single repo scope, the natural
    // intent for "Add Command" is to create one in that repo. When the filter
    // is narrowed to Global-only, honor that. Otherwise prefer the active
    // workspace repo; fall back to global when there's no active repo.
    if (!showAll) {
      const selectedRepoIds = [...effectiveSelection].filter((key) => key !== GLOBAL_SCOPE_KEY)
      if (selectedRepoIds.length === 1 && !effectiveSelection.has(GLOBAL_SCOPE_KEY)) {
        return createTerminalQuickCommandDraft({ type: 'repo', repoId: selectedRepoIds[0] })
      }
      if (selectedRepoIds.length === 0 && effectiveSelection.has(GLOBAL_SCOPE_KEY)) {
        return createTerminalQuickCommandDraft({ type: 'global' })
      }
    }
    if (activeRepoId && repoById.has(activeRepoId)) {
      return createTerminalQuickCommandDraft({ type: 'repo', repoId: activeRepoId })
    }
    return createTerminalQuickCommandDraft({ type: 'global' })
  }, [activeRepoId, effectiveSelection, repoById, showAll])

  const intentSignal = addCommandIntentSignal
  if (
    typeof intentSignal === 'number' &&
    shouldOpenQuickCommandAddIntent(intentSignal, consumedAddIntentSignalRef.current)
  ) {
    // Why: Settings deep-links use this one-shot signal to open the add dialog;
    // consume it before paint so the pane never flashes without the editor.
    consumedAddIntentSignalRef.current = intentSignal
    setEditor({ mode: 'add', command: createDraftForCurrentFilter() })
  }

  const toggleScope = (key: string): void => {
    const current = new Set(effectiveSelection)
    if (current.has(key)) {
      // Why: forbid the empty selection — every command would disappear and
      // there'd be no signal that the filter caused it.
      if (current.size <= 1) {
        return
      }
      current.delete(key)
    } else {
      current.add(key)
    }
    setScopeSelection(current.size === allScopeKeys.size ? null : current)
  }

  const handleSelectAll = (): void => {
    if (showAll) {
      // Why: tasks-page parity — clicking "All" while everything is selected
      // collapses to a single scope rather than emitting an empty set.
      setScopeSelection(new Set([GLOBAL_SCOPE_KEY]))
      return
    }
    setScopeSelection(null)
  }

  const renderTriggerLabel = (): React.JSX.Element => {
    if (showAll) {
      return <span>All commands</span>
    }
    const includesGlobal = effectiveSelection.has(GLOBAL_SCOPE_KEY)
    const selectedRepos = repos.filter((r) => effectiveSelection.has(r.id))
    const parts: string[] = []
    if (includesGlobal) {
      parts.push('Global')
    }
    if (selectedRepos.length > 0) {
      const [first, ...rest] = selectedRepos
      parts.push(rest.length > 0 ? `${first.displayName} +${rest.length}` : first.displayName)
    }
    return <span className="truncate">{parts.join(', ') || 'None'}</span>
  }

  const saveCommand = (next: TerminalQuickCommand): void => {
    // Why: re-read from the store so save lands on the latest list when
    // multiple edit dialogs fire in quick succession.
    const latest = useAppStore.getState().settings?.terminalQuickCommands ?? []
    const isEdit = latest.some((command) => command.id === next.id)
    const nextList = isEdit
      ? latest.map((command) => (command.id === next.id ? next : command))
      : [...latest, next]
    useAppStore.getState().recordFeatureInteraction('quick-commands')
    updateSettings({ terminalQuickCommands: nextList })
  }

  const removeCommand = async (command: TerminalQuickCommand): Promise<void> => {
    const confirmed = await confirm({
      title: `Delete "${command.label || 'Untitled'}"?`,
      description: 'This quick command will be removed from your saved list.',
      confirmLabel: 'Delete',
      confirmVariant: 'destructive'
    })
    if (!confirmed) {
      return
    }
    // Why: re-read latest list from the store at delete time — the await above
    // can span other settings changes, and a stale closure would resurrect
    // commands that were removed concurrently.
    const latest = useAppStore.getState().settings?.terminalQuickCommands ?? []
    updateSettings({
      terminalQuickCommands: latest.filter((c) => c.id !== command.id)
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 py-2">
        <div className="space-y-1">
          <Label>Saved Commands</Label>
          <p className="text-xs text-muted-foreground">
            Run them from the Quick Commands button in the tab bar, or right-click inside any
            terminal.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setEditor({ mode: 'add', command: createDraftForCurrentFilter() })}
        >
          <Plus />
          Add Command
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Popover open={scopePopoverOpen} onOpenChange={setScopePopoverOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={scopePopoverOpen}
              className="h-8 min-w-52 justify-between px-3 text-xs font-normal"
            >
              {renderTriggerLabel()}
              <ChevronsUpDown className="size-3.5 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-[min(320px,calc(100vw-1rem))] min-w-[var(--radix-popover-trigger-width)] p-0"
          >
            <Command>
              <div className="border-b border-border">
                <button
                  type="button"
                  onClick={handleSelectAll}
                  onMouseDown={(event) => event.preventDefault()}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
                    showAll && 'opacity-80'
                  )}
                >
                  <Check
                    className={cn(
                      'size-3 text-muted-foreground',
                      showAll ? 'opacity-70' : 'opacity-0'
                    )}
                  />
                  <span>All commands</span>
                </button>
              </div>
              <CommandList>
                <CommandItem
                  value={GLOBAL_SCOPE_KEY}
                  onSelect={() => toggleScope(GLOBAL_SCOPE_KEY)}
                  className="items-center gap-2 px-3 py-1.5 text-xs"
                >
                  <Check
                    className={cn(
                      'size-3 text-muted-foreground',
                      effectiveSelection.has(GLOBAL_SCOPE_KEY) ? 'opacity-70' : 'opacity-0'
                    )}
                  />
                  <span>Global</span>
                </CommandItem>
                {repos.map((repo) => {
                  const isSelected = effectiveSelection.has(repo.id)
                  return (
                    <CommandItem
                      key={repo.id}
                      value={repo.id}
                      onSelect={() => toggleScope(repo.id)}
                      className="items-center gap-2 px-3 py-1.5 text-xs"
                    >
                      <Check
                        className={cn(
                          'size-3 text-muted-foreground',
                          isSelected ? 'opacity-70' : 'opacity-0'
                        )}
                      />
                      <RepoBadgeLabel
                        name={getRepoLabel(repo)}
                        color={repo.badgeColor}
                        className="max-w-full"
                      />
                    </CommandItem>
                  )
                })}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      <div className="overflow-hidden rounded-lg border border-border/50 bg-muted/20">
        {visibleCommands.length === 0 ? (
          <div className="px-3 py-6 text-sm text-muted-foreground">
            {commands.length === 0
              ? 'No quick commands saved.'
              : 'No commands in the selected scopes.'}
          </div>
        ) : (
          <div className="max-h-[60vh] space-y-2 overflow-y-auto p-2 scrollbar-sleek">
            {visibleCommands.map((command) => {
              const scope = getTerminalQuickCommandScope(command)
              return (
                <div
                  key={command.id}
                  className="flex items-center gap-3 rounded-md border border-border/60 bg-background px-3 py-2 shadow-xs"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="truncate text-sm font-medium">
                        {command.label || 'Untitled'}
                      </div>
                      <Badge variant="outline" className="max-w-44 gap-1.5">
                        {scope.type === 'repo' ? (
                          <>
                            <RepoBadgeMark color={repoById.get(scope.repoId)?.badgeColor} />
                            <span className="truncate">{getScopeLabel(scope, repoById)}</span>
                          </>
                        ) : (
                          <span className="truncate">{getScopeLabel(scope, repoById)}</span>
                        )}
                      </Badge>
                    </div>
                    <div className="flex min-w-0 items-center gap-1.5 text-xs text-foreground/80">
                      {isTerminalAgentQuickCommand(command) ? (
                        <span className="shrink-0 text-muted-foreground">
                          <AgentIcon agent={command.agent} size={12} />
                        </span>
                      ) : null}
                      <span
                        className={cn(
                          'truncate',
                          isTerminalAgentQuickCommand(command) ? '' : 'font-mono'
                        )}
                      >
                        {isTerminalAgentQuickCommand(command)
                          ? `${getAgentLabel(command.agent)}: ${getTerminalQuickCommandBody(command)}`
                          : getTerminalQuickCommandBody(command) || 'No command text'}
                      </span>
                    </div>
                  </div>
                  <div className="shrink-0 text-[11px] font-medium text-foreground/75">
                    {isTerminalAgentQuickCommand(command)
                      ? 'Agent'
                      : command.appendEnter
                        ? 'Enter'
                        : 'Insert'}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Edit ${command.label || 'quick command'}`}
                    onClick={() => setEditor({ mode: 'edit', command })}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${command.label || 'quick command'}`}
                    onClick={() => void removeCommand(command)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 />
                  </Button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {editor !== null ? (
        <TerminalQuickCommandDialog
          open
          mode={editor.mode}
          command={editor.command}
          repos={repos}
          onOpenChange={(open) => !open && setEditor(null)}
          onSave={saveCommand}
        />
      ) : null}
    </div>
  )
}
