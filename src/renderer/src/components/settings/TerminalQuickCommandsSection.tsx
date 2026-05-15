import { useEffect, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import type { TerminalQuickCommand } from '../../../../shared/types'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

type TerminalQuickCommandsSectionProps = {
  commands: TerminalQuickCommand[]
  onChange: (commands: TerminalQuickCommand[]) => void
}

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

function createQuickCommand(): TerminalQuickCommand {
  return {
    id: `quick-command-${createBrowserUuid()}`,
    label: '',
    command: '',
    appendEnter: true
  }
}

export function TerminalQuickCommandsSection({
  commands,
  onChange
}: TerminalQuickCommandsSectionProps): React.JSX.Element {
  const [editor, setEditor] = useState<EditorState>(null)
  const [draft, setDraft] = useState<TerminalQuickCommand>(createQuickCommand)

  useEffect(() => {
    if (editor) {
      setDraft({ ...editor.command })
    }
  }, [editor])

  const saveDraft = (): void => {
    const next = {
      ...draft,
      label: draft.label.trim(),
      command: draft.command.trimEnd()
    }
    if (!next.label || !next.command) {
      return
    }
    if (editor?.mode === 'edit') {
      onChange(commands.map((command) => (command.id === next.id ? next : command)))
    } else {
      onChange([...commands, next])
    }
    setEditor(null)
  }

  const removeCommand = (id: string): void => {
    onChange(commands.filter((command) => command.id !== id))
  }

  const canSave = draft.label.trim().length > 0 && draft.command.trimEnd().length > 0

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
          onClick={() => setEditor({ mode: 'add', command: createQuickCommand() })}
        >
          <Plus />
          Add Command
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border border-border/50">
        {commands.length === 0 ? (
          <div className="px-3 py-6 text-sm text-muted-foreground">No quick commands saved.</div>
        ) : (
          <div className="divide-y divide-border/50">
            {commands.map((command) => (
              <div key={command.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{command.label || 'Untitled'}</div>
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
            ))}
          </div>
        )}
      </div>

      <Dialog open={editor !== null} onOpenChange={(open) => !open && setEditor(null)}>
        <DialogContent className="max-w-md sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-sm">
              {editor?.mode === 'edit' ? 'Edit Quick Command' : 'Add Quick Command'}
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
            <Button type="button" variant="outline" onClick={() => setEditor(null)}>
              Cancel
            </Button>
            <Button type="button" onClick={saveDraft} disabled={!canSave}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
