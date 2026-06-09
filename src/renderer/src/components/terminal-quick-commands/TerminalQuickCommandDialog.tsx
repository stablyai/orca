import { useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type {
  Repo,
  TerminalQuickCommand,
  TerminalQuickCommandScope
} from '../../../../shared/types'
import {
  getTerminalQuickCommandAction,
  getTerminalQuickCommandScope,
  isTerminalAgentQuickCommand,
  supportsTerminalAgentQuickCommand
} from '../../../../shared/terminal-quick-commands'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { AGENT_CATALOG, AgentIcon } from '@/lib/agent-catalog'
import { getScreenSubmitShortcutLabel, isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import type { TuiAgent } from '../../../../shared/types'
import { TerminalQuickCommandActionToggle } from './TerminalQuickCommandActionToggle'
import { TerminalQuickCommandAppendEnterSwitch } from './TerminalQuickCommandAppendEnterSwitch'
import { TerminalQuickCommandDialogFooter } from './TerminalQuickCommandDialogFooter'
import { TerminalQuickCommandLabelField } from './TerminalQuickCommandLabelField'
import { TerminalQuickCommandScopeField } from './TerminalQuickCommandScopeField'
import {
  createTerminalQuickCommandDialogDraftMemory,
  switchTerminalQuickCommandDialogAction
} from './terminal-quick-command-dialog-draft'
import { cn } from '@/lib/utils'
import { getTerminalQuickCommandAgentOptions } from './terminal-quick-command-agent-options'

type TerminalQuickCommandDialogMode = 'add' | 'edit'

type TerminalQuickCommandDialogProps = {
  open: boolean
  mode: TerminalQuickCommandDialogMode
  command: TerminalQuickCommand
  repos?: Pick<Repo, 'id' | 'displayName' | 'path' | 'badgeColor'>[]
  onOpenChange: (open: boolean) => void
  onSave: (command: TerminalQuickCommand) => void
}

const EMPTY_REPOS: Pick<Repo, 'id' | 'displayName' | 'path' | 'badgeColor'>[] = []
const QUICK_COMMAND_AGENT_OPTIONS = getTerminalQuickCommandAgentOptions()

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

export function TerminalQuickCommandDialog({
  open,
  mode,
  command,
  repos = EMPTY_REPOS,
  onOpenChange,
  onSave
}: TerminalQuickCommandDialogProps): React.JSX.Element {
  const fallbackAgent: TuiAgent =
    AGENT_CATALOG.find((entry) => supportsTerminalAgentQuickCommand(entry.id))?.id ?? 'claude'
  const [draft, setDraft] = useState<TerminalQuickCommand>(command)
  const wasOpenRef = useRef(open)
  const syncedCommandRef = useRef(command)
  const draftMemoryRef = useRef(createTerminalQuickCommandDialogDraftMemory(command, fallbackAgent))
  const initialScope = getTerminalQuickCommandScope(command)
  const lastRepoScopeIdRef = useRef<string | null>(
    initialScope.type === 'repo' ? initialScope.repoId : null
  )
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const selectedAction = getTerminalQuickCommandAction(draft)
  const selectedScope = getTerminalQuickCommandScope(draft)
  const isAgentAction = isTerminalAgentQuickCommand(draft)
  // Why: repo-scoped commands can outlive the current repo list; only an
  // explicit selection should replace the saved repo id.
  const selectedRepo =
    selectedScope.type === 'repo'
      ? (repos.find((repo) => repo.id === selectedScope.repoId) ?? null)
      : null
  const selectedRepoId = selectedRepo?.id ?? ''
  const selectedRepoMissing = selectedScope.type === 'repo' && selectedRepo === null

  if (!open) {
    wasOpenRef.current = false
  } else if (!wasOpenRef.current || syncedCommandRef.current !== command) {
    wasOpenRef.current = true
    syncedCommandRef.current = command
    // Why: opening or retargeting the dialog should render the new command
    // draft immediately instead of repairing it in a follow-up Effect.
    draftMemoryRef.current = createTerminalQuickCommandDialogDraftMemory(command, fallbackAgent)
    const commandScope = getTerminalQuickCommandScope(command)
    lastRepoScopeIdRef.current = commandScope.type === 'repo' ? commandScope.repoId : null
    setAdvancedOpen(false)
    setDraft({ ...command })
  }

  const selectedAgent =
    isAgentAction && supportsTerminalAgentQuickCommand(draft.agent) ? draft.agent : fallbackAgent

  const setAction = (action: 'terminal-command' | 'agent-prompt'): void => {
    setDraft((current) => {
      const next = switchTerminalQuickCommandDialogAction(current, action, draftMemoryRef.current)
      draftMemoryRef.current = next.memory
      return next.draft
    })
  }

  const toggleAppendEnter = (): void => {
    setDraft((current) =>
      isTerminalAgentQuickCommand(current)
        ? current
        : (() => {
            const appendEnter = !current.appendEnter
            draftMemoryRef.current = {
              ...draftMemoryRef.current,
              terminalAppendEnter: appendEnter
            }
            return { ...current, appendEnter }
          })()
    )
  }

  const saveDraft = (): void => {
    const next: TerminalQuickCommand = isTerminalAgentQuickCommand(draft)
      ? {
          id: draft.id,
          label: draft.label.trim(),
          action: 'agent-prompt',
          agent: draft.agent,
          prompt: draft.prompt.trimEnd(),
          scope: selectedScope
        }
      : {
          id: draft.id,
          label: draft.label.trim(),
          action: 'terminal-command',
          command: draft.command.trimEnd(),
          appendEnter: draft.appendEnter,
          scope: selectedScope
        }
    if (
      !next.label ||
      (isTerminalAgentQuickCommand(next)
        ? !next.prompt.trim() || !supportsTerminalAgentQuickCommand(next.agent)
        : !next.command.trim())
    ) {
      return
    }
    onSave(next)
    onOpenChange(false)
  }

  const canSave =
    draft.label.trim().length > 0 &&
    (isAgentAction
      ? draft.prompt.trimEnd().length > 0 && supportsTerminalAgentQuickCommand(draft.agent)
      : draft.command.trimEnd().length > 0)
  const submitShortcutLabel = getScreenSubmitShortcutLabel()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {mode === 'edit' ? 'Edit Quick Command' : 'Add Quick Command'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Save terminal commands or agent prompts for quick access.
          </DialogDescription>
        </DialogHeader>

        <div
          className="space-y-4"
          onKeyDown={(event) => {
            if (isScreenSubmitShortcut(event) && canSave) {
              event.preventDefault()
              saveDraft()
            }
          }}
        >
          <TerminalQuickCommandLabelField label={draft.label} setDraft={setDraft} />

          <div className="space-y-2">
            <Label>Action</Label>
            <TerminalQuickCommandActionToggle
              selectedAction={selectedAction}
              onActionChange={setAction}
            />
          </div>

          <div>
            {/* Why: action changes add/remove agent-only fields; animating rows here
                keeps the fixed dialog from snapping between content heights. */}
            <div
              className={cn(
                'grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out',
                isAgentAction ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
              )}
              aria-hidden={!isAgentAction}
            >
              <div className="min-h-0">
                <div
                  className={cn(
                    'space-y-2 px-1 pt-1 pb-4 transition-[opacity,transform] duration-150 ease-out',
                    isAgentAction
                      ? 'translate-y-0 opacity-100 delay-200'
                      : '-translate-y-1 opacity-0 delay-0'
                  )}
                >
                  <Label>Agent</Label>
                  <Select
                    value={selectedAgent}
                    disabled={!isAgentAction}
                    onValueChange={(agent) => {
                      const nextAgent = agent as TuiAgent
                      draftMemoryRef.current = {
                        ...draftMemoryRef.current,
                        agent: nextAgent
                      }
                      setDraft((current) =>
                        isTerminalAgentQuickCommand(current)
                          ? { ...current, agent: nextAgent }
                          : current
                      )
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Choose agent" />
                    </SelectTrigger>
                    <SelectContent
                      position="popper"
                      side="bottom"
                      align="start"
                      sideOffset={4}
                      className="max-h-[min(20rem,var(--radix-select-content-available-height))] w-[--radix-select-trigger-width]"
                    >
                      {QUICK_COMMAND_AGENT_OPTIONS.map((entry) => {
                        const supported = supportsTerminalAgentQuickCommand(entry.id)
                        return (
                          <SelectItem key={entry.id} value={entry.id} disabled={!supported}>
                            <span className="flex min-w-0 items-center gap-2">
                              <AgentIcon agent={entry.id} size={16} />
                              <span className="flex min-w-0 flex-col">
                                <span className="truncate">{entry.label}</span>
                                {!supported ? (
                                  <span className="truncate text-xs text-muted-foreground">
                                    Does not support prompt commands
                                  </span>
                                ) : null}
                              </span>
                            </span>
                          </SelectItem>
                        )
                      })}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label>{isAgentAction ? 'Prompt' : 'Command Text'}</Label>
              <textarea
                value={isAgentAction ? draft.prompt : draft.command}
                onChange={(event) => {
                  const text = event.target.value
                  draftMemoryRef.current = isAgentAction
                    ? {
                        ...draftMemoryRef.current,
                        agentPrompt: text
                      }
                    : {
                        ...draftMemoryRef.current,
                        terminalCommand: text
                      }
                  setDraft((current) =>
                    isTerminalAgentQuickCommand(current)
                      ? { ...current, prompt: text }
                      : { ...current, command: text }
                  )
                }}
                placeholder={
                  isAgentAction ? 'Ask the agent to investigate this workspace' : 'npm run dev'
                }
                rows={4}
                className={cn(
                  'min-h-24 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  !isAgentAction && 'font-mono'
                )}
              />
            </div>

            <div
              className={cn(
                'grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out',
                isAgentAction ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
              )}
              aria-hidden={!isAgentAction}
            >
              <div className="min-h-0">
                <p
                  className={cn(
                    'px-1 pt-2 text-xs text-muted-foreground transition-[opacity,transform] duration-150 ease-out',
                    isAgentAction
                      ? 'translate-y-0 opacity-100 delay-200'
                      : '-translate-y-1 opacity-0 delay-0'
                  )}
                >
                  Supports skills, file paths, and built-in commands like{' '}
                  <code className="rounded bg-muted px-1 font-mono text-[11px]">/goal</code>.
                </p>
              </div>
            </div>
          </div>

          <div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setAdvancedOpen((current) => !current)}
              className="-ml-2 text-xs"
            >
              Advanced
              <ChevronDown
                className={cn('size-4 transition-transform', advancedOpen && 'rotate-180')}
              />
            </Button>
          </div>

          <div
            className={cn(
              'grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out',
              advancedOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
            )}
            aria-hidden={!advancedOpen}
          >
            <div className="min-h-0">
              <div
                className={cn(
                  'space-y-4 px-1 pt-1 pb-1 transition-[opacity,transform] duration-150 ease-out',
                  advancedOpen
                    ? 'translate-y-0 opacity-100 delay-200'
                    : '-translate-y-1 opacity-0 delay-0'
                )}
              >
                {!isTerminalAgentQuickCommand(draft) ? (
                  <TerminalQuickCommandAppendEnterSwitch
                    appendEnter={draft.appendEnter}
                    onToggle={toggleAppendEnter}
                  />
                ) : null}
                <TerminalQuickCommandScopeField
                  repos={repos}
                  selectedScope={selectedScope}
                  selectedRepoId={selectedRepoId}
                  selectedRepoMissing={selectedRepoMissing}
                  lastRepoScopeId={lastRepoScopeIdRef.current}
                  rememberRepoScopeId={(repoId) => {
                    lastRepoScopeIdRef.current = repoId
                  }}
                  setDraft={setDraft}
                />
              </div>
            </div>
          </div>
        </div>

        <TerminalQuickCommandDialogFooter
          canSave={canSave}
          submitShortcutLabel={submitShortcutLabel}
          onCancel={() => onOpenChange(false)}
          onSave={saveDraft}
        />
      </DialogContent>
    </Dialog>
  )
}
