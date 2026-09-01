import { AgentIcon } from '@/lib/agent-catalog'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { BuiltInTuiAgent } from '../../../../shared/types'

export const PIN_EXIT_CUSTOM_AGENT_EXAMPLE_NAME = 'Luna (low)'
export const PIN_EXIT_CUSTOM_AGENT_EXAMPLE_COMMAND =
  'codex --model gpt-5.6-luna -c model_reasoning_effort="low"'
export const PIN_EXIT_CUSTOM_AGENT_EXAMPLE_2_NAME = 'Luna (high)'
export const PIN_EXIT_CUSTOM_AGENT_EXAMPLE_2_COMMAND =
  'codex --model gpt-5.6-luna -c model_reasoning_effort="high"'

/** Static picker mock: customs sit under their base, with names a person would pick. */
export function DataRecoveryPinExitCustomAgentExample() {
  return (
    <div aria-hidden className="overflow-hidden rounded-md border border-border bg-card text-left">
      <div className="border-b border-border/60 bg-muted/30 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {translate('auto.components.dataRecovery.pinExitExampleCaption', 'Agent picker')}
      </div>
      <div className="divide-y divide-border/60">
        <ExamplePickerRow agent="codex" label="Codex" />
        <ExamplePickerRow
          agent="codex"
          label={PIN_EXIT_CUSTOM_AGENT_EXAMPLE_NAME}
          command={PIN_EXIT_CUSTOM_AGENT_EXAMPLE_COMMAND}
          isCustom
          selected
        />
        <ExamplePickerRow
          agent="codex"
          label={PIN_EXIT_CUSTOM_AGENT_EXAMPLE_2_NAME}
          command={PIN_EXIT_CUSTOM_AGENT_EXAMPLE_2_COMMAND}
          isCustom
        />
      </div>
    </div>
  )
}

function ExamplePickerRow({
  agent,
  label,
  command,
  isCustom = false,
  selected = false
}: {
  agent: BuiltInTuiAgent
  label: string
  command?: string
  isCustom?: boolean
  selected?: boolean
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 px-3 py-2',
        selected &&
          'bg-[color-mix(in_srgb,var(--foreground)_10%,var(--background))] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--foreground)_12%,transparent)]'
      )}
      data-current={selected ? 'true' : undefined}
    >
      <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center">
        <AgentIcon agent={agent} size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{label}</span>
          {isCustom ? (
            <Badge variant="outline" className="font-normal">
              {translate('auto.components.dataRecovery.pinExitExampleBadge', 'Custom')}
            </Badge>
          ) : null}
        </div>
        {command ? (
          <p className="mt-0.5 font-mono text-xs leading-relaxed text-muted-foreground">
            {command}
          </p>
        ) : null}
      </div>
    </div>
  )
}
