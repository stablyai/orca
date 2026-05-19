import { useEffect, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import type {
  Repo,
  TerminalQuickCommand,
  TerminalQuickCommandScope
} from '../../../../shared/types'
import { getTerminalQuickCommandScope } from '../../../../shared/terminal-quick-commands'
import {
  createTerminalQuickCommandDraft,
  TerminalQuickCommandDialog
} from '@/components/terminal-quick-commands/TerminalQuickCommandDialog'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import RepoDotLabel from '../repo/RepoDotLabel'

type TerminalQuickCommandsSectionProps = {
  commands: TerminalQuickCommand[]
  repos: Pick<Repo, 'id' | 'displayName' | 'path' | 'badgeColor'>[]
  activeRepoId: string | null
  onChange: (commands: TerminalQuickCommand[]) => void
}

type ScopeFilter = 'all' | 'global' | 'repo'

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

function getScopeLabel(
  scope: TerminalQuickCommandScope,
  repoById: Map<string, Pick<Repo, 'displayName' | 'path' | 'badgeColor'>>
): string {
  if (scope.type === 'global') {
    return 'Global'
  }
  const repo = repoById.get(scope.repoId)
  return repo ? getRepoLabel(repo) : 'Missing repo'
}

export function TerminalQuickCommandsSection({
  commands,
  repos,
  activeRepoId,
  onChange
}: TerminalQuickCommandsSectionProps): React.JSX.Element {
  const [editor, setEditor] = useState<EditorState>(null)
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all')
  const [repoFilterId, setRepoFilterId] = useState(activeRepoId ?? '')
  const [repoFilterManuallyChanged, setRepoFilterManuallyChanged] = useState(false)
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  const activeRepoFilterId = activeRepoId && repoById.has(activeRepoId) ? activeRepoId : ''
  const repoFilterIsValid = repoFilterId !== '' && repoById.has(repoFilterId)
  const selectedRepoId =
    activeRepoFilterId && (!repoFilterManuallyChanged || !repoFilterIsValid)
      ? activeRepoFilterId
      : repoFilterIsValid
        ? repoFilterId
        : (repos[0]?.id ?? '')
  const visibleCommands = commands.filter((command) => {
    const scope = getTerminalQuickCommandScope(command)
    if (scopeFilter === 'global') {
      return scope.type === 'global'
    }
    if (scopeFilter === 'repo') {
      return scope.type === 'repo' && (!selectedRepoId || scope.repoId === selectedRepoId)
    }
    return true
  })

  const createDraftForCurrentFilter = (): TerminalQuickCommand => {
    if (scopeFilter === 'repo' && selectedRepoId) {
      return createTerminalQuickCommandDraft({ type: 'repo', repoId: selectedRepoId })
    }
    return createTerminalQuickCommandDraft({ type: 'global' })
  }

  // Follow the active worktree until the user picks a repo; resume if that repo disappears.
  useEffect(() => {
    if (!activeRepoFilterId) {
      return
    }

    if (!repoFilterManuallyChanged) {
      if (repoFilterId !== activeRepoFilterId) {
        setRepoFilterId(activeRepoFilterId)
      }
      return
    }

    if (!repoFilterIsValid) {
      setRepoFilterId(activeRepoFilterId)
      setRepoFilterManuallyChanged(false)
    }
  }, [activeRepoFilterId, repoFilterId, repoFilterIsValid, repoFilterManuallyChanged])

  const changeRepoFilter = (nextRepoId: string): void => {
    setRepoFilterManuallyChanged(true)
    setRepoFilterId(nextRepoId)
  }

  const saveCommand = (next: TerminalQuickCommand): void => {
    if (editor?.mode === 'edit') {
      onChange(commands.map((command) => (command.id === next.id ? next : command)))
    } else {
      onChange([...commands, next])
    }
  }

  const removeCommand = (id: string): void => {
    onChange(commands.filter((command) => command.id !== id))
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <Label>Saved Commands</Label>
          <p className="text-xs text-muted-foreground">
            Commands are sent as plain terminal input to the active pane.
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
        <ToggleGroup
          type="single"
          value={scopeFilter}
          onValueChange={(value) => {
            if (value === 'all' || value === 'global' || value === 'repo') {
              setScopeFilter(value)
            }
          }}
          className="justify-start"
        >
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="global">Global</ToggleGroupItem>
          <ToggleGroupItem value="repo" disabled={repos.length === 0}>
            Repository
          </ToggleGroupItem>
        </ToggleGroup>
        {scopeFilter === 'repo' && repos.length > 0 ? (
          <Select value={selectedRepoId} onValueChange={changeRepoFilter}>
            <SelectTrigger size="sm" className="min-w-52">
              <SelectValue placeholder="Choose repository" />
            </SelectTrigger>
            <SelectContent>
              {repos.map((repo) => (
                <SelectItem key={repo.id} value={repo.id}>
                  <RepoDotLabel
                    name={getRepoLabel(repo)}
                    color={repo.badgeColor}
                    className="max-w-full"
                  />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-lg border border-border/50">
        {visibleCommands.length === 0 ? (
          <div className="px-3 py-6 text-sm text-muted-foreground">
            {commands.length === 0 ? 'No quick commands saved.' : 'No commands match this scope.'}
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {visibleCommands.map((command) => {
              const scope = getTerminalQuickCommandScope(command)
              return (
                <div key={command.id} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="truncate text-sm font-medium">
                        {command.label || 'Untitled'}
                      </div>
                      <Badge variant="outline" className="max-w-44">
                        <span className="truncate">{getScopeLabel(scope, repoById)}</span>
                      </Badge>
                    </div>
                    <div className="truncate font-mono text-xs text-muted-foreground">
                      {command.command || 'No command text'}
                    </div>
                  </div>
                  <div className="shrink-0 text-[11px] text-muted-foreground">
                    {command.appendEnter ? 'Enter' : 'Insert'}
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
                    onClick={() => removeCommand(command.id)}
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

      <TerminalQuickCommandDialog
        open={editor !== null}
        mode={editor?.mode ?? 'add'}
        command={editor?.command ?? createTerminalQuickCommandDraft()}
        repos={repos}
        onOpenChange={(open) => !open && setEditor(null)}
        onSave={saveCommand}
      />
    </div>
  )
}
