import { useEffect, useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type {
  Repo,
  TerminalQuickCommand,
  TerminalQuickCommandScope
} from '../../../../shared/types'
import { getTerminalQuickCommandScope } from '../../../../shared/terminal-quick-commands'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { isMacUserAgent } from '@/components/terminal-pane/pane-helpers'
import { AGENT_CATALOG, AgentIcon } from '@/lib/agent-catalog'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { useAppStore } from '@/store'
import {
  buildTerminalAgentQuickCommandPreset,
  type TerminalAgentQuickCommandPreset
} from './terminal-agent-quick-command-presets'

type TerminalQuickCommandDialogMode = 'add' | 'edit'

const EMPTY_AGENT_CMD_OVERRIDES = {}

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

function filterAgentPresets(
  presets: TerminalAgentQuickCommandPreset[],
  rawQuery: string
): TerminalAgentQuickCommandPreset[] {
  const query = rawQuery.trim().toLowerCase()
  if (!query) {
    return presets
  }
  return presets.filter((preset) => {
    return preset.label.toLowerCase().includes(query) || preset.agent.toLowerCase().includes(query)
  })
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
  const [agentPresetOpen, setAgentPresetOpen] = useState(false)
  const [agentPresetQuery, setAgentPresetQuery] = useState('')
  const agentCmdOverrides = useAppStore(
    (s) => s.settings?.agentCmdOverrides ?? EMPTY_AGENT_CMD_OVERRIDES
  )
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
      setAgentPresetOpen(false)
      setAgentPresetQuery('')
    }
  }, [command, open])

  const agentPresets = useMemo(() => {
    return AGENT_CATALOG.map((entry, index) => {
      const preset = buildTerminalAgentQuickCommandPreset({
        agent: entry.id,
        label: entry.label,
        cmdOverrides: agentCmdOverrides,
        platform: CLIENT_PLATFORM
      })
      return preset ? { preset, index } : null
    })
      .filter((item): item is { preset: TerminalAgentQuickCommandPreset; index: number } =>
        Boolean(item)
      )
      .sort((a, b) => a.index - b.index)
      .map((item) => item.preset)
  }, [agentCmdOverrides])

  const visibleAgentPresets = useMemo(
    () => filterAgentPresets(agentPresets, agentPresetQuery),
    [agentPresetQuery, agentPresets]
  )

  const selectAgentPreset = (preset: TerminalAgentQuickCommandPreset): void => {
    setDraft((current) => ({
      ...current,
      command: preset.command
    }))
    setAgentPresetOpen(false)
    setAgentPresetQuery('')
  }

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
  const submitShortcutLabel = isMacUserAgent() ? '⌘↵' : 'Ctrl+Enter'

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

        <div
          className="space-y-4"
          onKeyDown={(event) => {
            // Why: cross-platform submit shortcut — Cmd+Enter on Mac, Ctrl+Enter
            // elsewhere. Falls through to native textarea/Input newline insertion
            // when the modifier isn't held.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canSave) {
              event.preventDefault()
              saveDraft()
            }
          }}
        >
          <div className="space-y-2">
            <Label>Label</Label>
            <Input
              value={draft.label}
              onChange={(event) =>
                setDraft((current) => ({ ...current, label: event.target.value }))
              }
              placeholder="Start dev server"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label>Command Text</Label>
              <Popover open={agentPresetOpen} onOpenChange={setAgentPresetOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="h-7 shrink-0 gap-1 px-2 text-xs font-normal"
                    aria-label="Insert an agent command"
                  >
                    Insert agent command
                    <ChevronDown className="size-3" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-[min(17rem,calc(100vw-2rem))] p-0">
                  <Command shouldFilter={false}>
                    <CommandInput
                      autoFocus
                      placeholder="Search agents"
                      value={agentPresetQuery}
                      onValueChange={setAgentPresetQuery}
                      className="h-9 text-xs"
                      wrapperClassName="px-3"
                    />
                    <CommandList className="max-h-64">
                      <CommandEmpty>No agents match your search.</CommandEmpty>
                      {visibleAgentPresets.map((preset) => (
                        <CommandItem
                          key={preset.agent}
                          value={`${preset.agent} ${preset.label}`}
                          disabled={!preset.startsWithPrompt}
                          onSelect={() => {
                            if (preset.startsWithPrompt) {
                              selectAgentPreset(preset)
                            }
                          }}
                          className="min-h-11 items-start gap-2 px-3 py-2"
                        >
                          <span className="mt-0.5">
                            <AgentIcon agent={preset.agent} size={16} />
                          </span>
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate text-sm font-medium">{preset.label}</span>
                            {!preset.startsWithPrompt ? (
                              <span className="truncate text-xs text-muted-foreground">
                                Does not support prompt commands
                              </span>
                            ) : null}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
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
                  Project
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
                        placeholder={selectedRepoMissing ? 'Project not in list' : 'Choose project'}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {repos.map((repo) => (
                        <SelectItem key={repo.id} value={repo.id}>
                          <RepoBadgeLabel
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
                      Saving keeps the existing project scope unless you choose another.
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
          <Button
            type="button"
            onClick={saveDraft}
            disabled={!canSave}
            title={`Save (${submitShortcutLabel})`}
          >
            Save
            <span className="ml-1 text-[10px] opacity-60">{submitShortcutLabel}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
