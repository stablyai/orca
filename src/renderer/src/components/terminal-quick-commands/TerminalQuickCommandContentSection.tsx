import { useId, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  isTerminalAgentQuickCommand,
  supportsTerminalAgentQuickCommand
} from '../../../../shared/terminal-quick-commands'
import {
  formatKilobytes,
  type TerminalQuickCommandBodySize
} from '../../../../shared/terminal-quick-command-prompt-limit'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { getTerminalQuickCommandAgentOptions } from './terminal-quick-command-agent-options'
import type { TerminalQuickCommandDialogDraftMemory } from './terminal-quick-command-dialog-draft'
import { TerminalQuickCommandAppendEnterSwitch } from './TerminalQuickCommandAppendEnterSwitch'

const QUICK_COMMAND_AGENT_OPTIONS = getTerminalQuickCommandAgentOptions()
// Why: long pastes are the common way to hit the cap, so the count appears before Save disables.
const BODY_LENGTH_COUNTER_THRESHOLD = 0.8

type TerminalQuickCommandContentSectionProps = {
  draft: TerminalQuickCommand
  isAgentAction: boolean
  selectedAgent: TuiAgent
  bodySize: TerminalQuickCommandBodySize
  draftMemoryRef: MutableRefObject<TerminalQuickCommandDialogDraftMemory>
  setDraft: Dispatch<SetStateAction<TerminalQuickCommand>>
  toggleAppendEnter: () => void
}

function getBodyLengthLabel(bodySize: TerminalQuickCommandBodySize): string {
  if (bodySize.unit === 'bytes') {
    return translate(
      'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.size_count',
      '{{value0}} / {{value1}}',
      { value0: formatKilobytes(bodySize.used), value1: formatKilobytes(bodySize.max) }
    )
  }
  return translate(
    'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.length_count',
    '{{value0}} / {{value1}} characters',
    { value0: bodySize.used.toLocaleString(), value1: bodySize.max.toLocaleString() }
  )
}

function getBodyRefusalLabel(belowCurrentPromptCap: boolean): string {
  return belowCurrentPromptCap
    ? translate(
        'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.prompt_over_host_limit',
        'Too long for this host. Update Orca on the host to save longer prompts.'
      )
    : translate(
        'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.length_over_limit',
        'Too long to save.'
      )
}

export function TerminalQuickCommandContentSection({
  draft,
  isAgentAction,
  selectedAgent,
  bodySize,
  draftMemoryRef,
  setDraft,
  toggleAppendEnter
}: TerminalQuickCommandContentSectionProps): React.JSX.Element {
  const bodyTooLong = bodySize.used > bodySize.max
  const showBodyLength = bodySize.used >= bodySize.max * BODY_LENGTH_COUNTER_THRESHOLD
  const lengthId = useId()
  const refusalId = useId()
  const describedBy =
    [showBodyLength ? lengthId : null, bodyTooLong ? refusalId : null].filter(Boolean).join(' ') ||
    undefined
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
      <div
        className={cn(
          'overflow-hidden rounded-md border border-border bg-[var(--editor-surface)] transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
          bodyTooLong &&
            'border-destructive ring-destructive/20 focus-within:border-destructive focus-within:ring-destructive/20 dark:ring-destructive/40 dark:focus-within:ring-destructive/40'
        )}
      >
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
          aria-invalid={bodyTooLong || undefined}
          aria-describedby={describedBy}
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
          {showBodyLength ? (
            <span className="flex shrink-0 items-center gap-2 text-[11px]">
              {/* Why static text in the alert: a live count would re-announce on every keystroke. */}
              {bodyTooLong ? (
                <span id={refusalId} role="alert" className="text-destructive">
                  {getBodyRefusalLabel(bodySize.olderHostCap)}
                </span>
              ) : null}
              <span
                id={lengthId}
                className={cn(
                  'tabular-nums',
                  bodyTooLong ? 'text-destructive' : 'text-muted-foreground'
                )}
              >
                {getBodyLengthLabel(bodySize)}
              </span>
            </span>
          ) : (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {translate(
                'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.resize_hint',
                'Drag corner to resize'
              )}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
