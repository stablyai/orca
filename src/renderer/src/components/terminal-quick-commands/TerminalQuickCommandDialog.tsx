import { useEffect, useState } from 'react'
import type {
  Repo,
  TerminalQuickCommand,
  TerminalQuickCommandScope
} from '../../../../shared/types'
import { getTerminalQuickCommandScope } from '../../../../shared/terminal-quick-commands'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import RepoDotLabel from '@/components/repo/RepoDotLabel'

type TerminalQuickCommandDialogMode = 'add' | 'edit'

type TerminalQuickCommandDialogProps = {
  open: boolean
  mode: TerminalQuickCommandDialogMode
  command: TerminalQuickCommand
  repos?: Pick<Repo, 'id' | 'displayName' | 'path' | 'badgeColor'>[]
  onOpenChange: (open: boolean) => void
  onSave: (command: TerminalQuickCommand) => void
}

export function createTerminalQuickCommandDraft(
  scope: TerminalQuickCommandScope = { type: 'global' }
): TerminalQuickCommand {
  return {
    id: `quick-command-${createBrowserUuid()}`,
    label: '',
    command: '',
    appendEnter: true,
    scope
  }
}

function getRepoLabel(repo: Pick<Repo, 'displayName' | 'path'>): string {
  return repo.displayName || repo.path
}

export function TerminalQuickCommandDialog({
  open,
  mode,
  command,
  repos = [],
  onOpenChange,
  onSave
}: TerminalQuickCommandDialogProps): React.JSX.Element {
  const [draft, setDraft] = useState<TerminalQuickCommand>(command)
  const selectedScope = getTerminalQuickCommandScope(draft)
  // Why: repo-scoped commands can outlive the current repo list; only an
  // explicit selection should replace the saved repo id.
  const selectedRepo =
    selectedScope.type === 'repo'
      ? (repos.find((repo) => repo.id === selectedScope.repoId) ?? null)
      : null
  const selectedRepoId = selectedRepo?.id ?? ''
  const selectedRepoMissing = selectedScope.type === 'repo' && selectedRepo === null

  useEffect(() => {
    if (open) {
      setDraft({ ...command })
    }
  }, [command, open])

  const saveDraft = (): void => {
    const next = {
      ...draft,
      label: draft.label.trim(),
      command: draft.command.trimEnd(),
      scope: selectedScope
    }
    if (!next.label || !next.command) {
      return
    }
    onSave(next)
    onOpenChange(false)
  }

  const canSave = draft.label.trim().length > 0 && draft.command.trimEnd().length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {mode === 'edit' ? 'Edit Quick Command' : 'Add Quick Command'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Save terminal input text for the context menu.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Label</Label>
            <Input
              value={draft.label}
              onChange={(event) =>
                setDraft((current) => ({ ...current, label: event.target.value }))
              }
              placeholder="Restart server"
            />
          </div>

          <div className="space-y-2">
            <Label>Command Text</Label>
            <textarea
              value={draft.command}
              onChange={(event) =>
                setDraft((current) => ({ ...current, command: event.target.value }))
              }
              placeholder="npm run dev"
              rows={4}
              className="min-h-24 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </div>

          <div className="space-y-2">
            <Label>Scope</Label>
            <div className="flex flex-wrap items-center gap-2">
              <ToggleGroup
                type="single"
                value={selectedScope.type}
                onValueChange={(value) => {
                  if (value === 'global') {
                    setDraft((current) => ({ ...current, scope: { type: 'global' } }))
                  }
                  if (value === 'repo' && repos[0]) {
                    if (selectedScope.type !== 'repo') {
                      setDraft((current) => ({
                        ...current,
                        scope: { type: 'repo', repoId: repos[0].id }
                      }))
                    }
                  }
                }}
                className="justify-start"
              >
                <ToggleGroupItem value="global">Global</ToggleGroupItem>
                <ToggleGroupItem value="repo" disabled={repos.length === 0}>
                  Repository
                </ToggleGroupItem>
              </ToggleGroup>
              {selectedScope.type === 'repo' && repos.length > 0 ? (
                <div className="space-y-1">
                  <Select
                    value={selectedRepoId}
                    onValueChange={(repoId) =>
                      setDraft((current) => ({ ...current, scope: { type: 'repo', repoId } }))
                    }
                  >
                    <SelectTrigger size="sm" className="min-w-48">
                      <SelectValue
                        placeholder={
                          selectedRepoMissing ? 'Repository not in list' : 'Choose repository'
                        }
                      />
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
                  {selectedRepoMissing ? (
                    <p className="max-w-48 text-xs text-muted-foreground">
                      Saving keeps the existing repo scope unless you choose another.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-md border border-border/50 px-3 py-2">
            <div className="space-y-0.5">
              <div className="text-sm font-medium">Append Enter</div>
              <div className="text-xs text-muted-foreground">
                Submit immediately instead of only inserting text.
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={draft.appendEnter}
              aria-label="Toggle append Enter"
              onClick={() =>
                setDraft((current) => ({ ...current, appendEnter: !current.appendEnter }))
              }
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                draft.appendEnter ? 'bg-foreground' : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                  draft.appendEnter ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={saveDraft} disabled={!canSave}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
