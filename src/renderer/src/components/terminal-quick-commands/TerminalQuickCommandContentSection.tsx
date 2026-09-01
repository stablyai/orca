import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  isTerminalAgentQuickCommand,
  supportsTerminalAgentQuickCommand
} from '../../../../shared/terminal-quick-commands'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { TerminalQuickCommandDialogDraftMemory } from './terminal-quick-command-dialog-draft'
import { TerminalQuickCommandAppendEnterSwitch } from './TerminalQuickCommandAppendEnterSwitch'

type TerminalQuickCommandContentSectionProps = {
  draft: TerminalQuickCommand
  isAgentAction: boolean
  selectedAgent: TuiAgent
  // Why a prop, not a module constant: the list must include the caller's live
  // catalog read so custom agents are selectable, not just the static built-ins.
  agentOptions: readonly AgentCatalogEntry[]
  draftMemoryRef: MutableRefObject<TerminalQuickCommandDialogDraftMemory>
  setDraft: Dispatch<SetStateAction<TerminalQuickCommand>>
  toggleAppendEnter: () => void
}

export function TerminalQuickCommandContentSection({
  draft,
  isAgentAction,
  selectedAgent,
  agentOptions,
  draftMemoryRef,
  setDraft,
  toggleAppendEnter
}: TerminalQuickCommandContentSectionProps): React.JSX.Element {
  const commandText = isTerminalAgentQuickCommand(draft) ? draft.prompt : draft.command
  // Why: the frame header is a plain span, so the textarea carries the accessible name itself.
  const commandFieldLabel = isAgentAction
    ? translate(
        'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.dc921c17ee',
        'Prompt'
      )
    : translate(
        'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.command_label',
        'Command'
      )

  return (
    <div className="space-y-3">
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
              'space-y-2 px-1 pt-1 pb-1 transition-[opacity,transform] duration-150 ease-out',
              isAgentAction
                ? 'translate-y-0 opacity-100 delay-200'
                : '-translate-y-1 opacity-0 delay-0'
            )}
          >
            <Label>
              {translate(
                'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.0adba8fa0c',
                'Agent'
              )}
            </Label>
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
                  isTerminalAgentQuickCommand(current) ? { ...current, agent: nextAgent } : current
                )
              }}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={translate(
                    'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.346d409ab2',
                    'Choose agent'
                  )}
                />
              </SelectTrigger>
              <SelectContent
                position="popper"
                side="bottom"
                align="start"
                sideOffset={4}
                className="max-h-[min(20rem,var(--radix-select-content-available-height))] w-[--radix-select-trigger-width]"
              >
                {agentOptions.map((entry) => {
                  const supported = supportsTerminalAgentQuickCommand(entry.id)
                  return (
                    <SelectItem key={entry.id} value={entry.id} disabled={!supported}>
                      <span className="flex min-w-0 items-center gap-2">
                        <AgentIcon agent={entry.id} size={16} />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{entry.label}</span>
                          {!supported ? (
                            <span className="truncate text-xs text-muted-foreground">
                              {translate(
                                'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.026cfb232a',
                                'Does not support prompt commands'
                              )}
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

      {/* Why: the textarea drops its own ring, so the frame carries the focus state. */}
      <div className="overflow-hidden rounded-md border border-border bg-[var(--editor-surface)] transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/70 px-3 py-2">
          <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            {commandFieldLabel}
          </span>
          {isAgentAction ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {translate(
                'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.agent_toolbar_hint',
                'Supports /goal, skills, paths'
              )}
            </span>
          ) : null}
        </div>

        <textarea
          value={commandText}
          aria-label={commandFieldLabel}
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
            isAgentAction
              ? translate(
                  'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.577a342c7d',
                  'Ask the agent to investigate this workspace'
                )
              : translate(
                  'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.79af0c0841',
                  'npm run dev'
                )
          }
          spellCheck={isAgentAction}
          rows={14}
          className={cn(
            'min-h-[21rem] w-full resize-y border-0 bg-transparent px-3.5 py-3 text-sm outline-none focus-visible:ring-0',
            !isAgentAction && 'font-mono text-[13px]'
          )}
        />

        <div className="flex items-center justify-between gap-3 border-t border-border bg-muted/50 px-3 py-2">
          {!isTerminalAgentQuickCommand(draft) ? (
            <TerminalQuickCommandAppendEnterSwitch
              appendEnter={draft.appendEnter}
              onToggle={toggleAppendEnter}
              compact
            />
          ) : (
            <span className="text-[11px] text-muted-foreground">
              {translate(
                'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.agent_footer_hint',
                'Multi-line prompts are fine — keep them focused.'
              )}
            </span>
          )}
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {translate(
              'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.resize_hint',
              'Drag corner to resize'
            )}
          </span>
        </div>
      </div>
    </div>
  )
}
