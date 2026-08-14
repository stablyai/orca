import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { TerminalQuickCommand, TuiAgent } from '../../../../shared/types'
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
import { Textarea } from '@/components/ui/textarea'
import { AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { TerminalQuickCommandCollapsibleRow } from './TerminalQuickCommandCollapsibleRow'
import { getTerminalQuickCommandAgentOptions } from './terminal-quick-command-agent-options'
import type { TerminalQuickCommandDialogDraftMemory } from './terminal-quick-command-dialog-draft'

const QUICK_COMMAND_AGENT_OPTIONS = getTerminalQuickCommandAgentOptions()

type TerminalQuickCommandContentSectionProps = {
  draft: TerminalQuickCommand
  isAgentAction: boolean
  selectedAgent: TuiAgent
  draftMemoryRef: MutableRefObject<TerminalQuickCommandDialogDraftMemory>
  setDraft: Dispatch<SetStateAction<TerminalQuickCommand>>
}

export function TerminalQuickCommandContentSection({
  draft,
  isAgentAction,
  selectedAgent,
  draftMemoryRef,
  setDraft
}: TerminalQuickCommandContentSectionProps): React.JSX.Element {
  return (
    <div>
      <TerminalQuickCommandCollapsibleRow open={isAgentAction} className="space-y-2 px-1 pt-1 pb-4">
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
      </TerminalQuickCommandCollapsibleRow>

      <div className="space-y-2">
        <Label>
          {isAgentAction
            ? translate(
                'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.dc921c17ee',
                'Prompt'
              )
            : translate(
                'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.ca414324ee',
                'Command Text'
              )}
        </Label>
        <Textarea
          value={isTerminalAgentQuickCommand(draft) ? draft.prompt : draft.command}
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
          rows={8}
          spellCheck={isAgentAction}
          className={cn(
            'max-h-[40vh] min-h-40 resize-y text-sm leading-relaxed',
            !isAgentAction && 'font-mono'
          )}
        />
      </div>

      <TerminalQuickCommandCollapsibleRow
        open={isAgentAction}
        className="px-1 pt-2 text-xs text-muted-foreground"
      >
        {translate(
          'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.e604bd40d6',
          'Supports skills, file paths, and built-in commands like'
        )}{' '}
        <code className="rounded bg-muted px-1 font-mono text-[11px]">
          {translate(
            'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.97e96cc027',
            '/goal'
          )}
        </code>
        .
      </TerminalQuickCommandCollapsibleRow>
    </div>
  )
}
