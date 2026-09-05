import React from 'react'
import { Gauge } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { selectActiveTerminalPaneKey } from '@/store/active-terminal-pane-key'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { computeTokensPerSecond } from '../../../../shared/agent-throughput-types'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../shared/tui-agent-display-names'
import { formatTokens } from '../stats/usage-formatters'
import { formatGenerationDuration, formatTokensPerSecondValue } from './agent-throughput-format'
import {
  resolveAgentThroughputPlaceholderReason,
  type AgentThroughputPlaceholderReason
} from './agent-throughput-placeholder'

function getAgentDisplayName(agentType: string): string {
  return (TUI_AGENT_DISPLAY_NAMES as Record<string, string | undefined>)[agentType] ?? agentType
}

function readoutLabel(value: string): string {
  return translate(
    'auto.components.status.bar.AgentThroughputStatusSegment.tokensPerSecond',
    '{{value}} tok/s',
    { value }
  )
}

function placeholderHint(reason: AgentThroughputPlaceholderReason, agentType?: string): string {
  if (reason === 'no-pane') {
    return translate(
      'auto.components.status.bar.AgentThroughputStatusSegment.noPane',
      'Focus a terminal running an agent.'
    )
  }
  if (reason === 'unmeasured-agent') {
    return translate(
      'auto.components.status.bar.AgentThroughputStatusSegment.unmeasuredAgent',
      'Not available for {{agent}}: no token counts recorded.',
      { agent: getAgentDisplayName(agentType ?? '') }
    )
  }
  return translate(
    'auto.components.status.bar.AgentThroughputStatusSegment.waiting',
    'No completed message in this terminal yet.'
  )
}

// Why: TooltipTrigger renders this as its child, so the ref and pointer handlers it injects must
// land on the button or the tooltip never opens.
function Readout({
  iconOnly,
  value,
  emphasized,
  className,
  ...triggerProps
}: {
  iconOnly: boolean
  value: string
  emphasized: boolean
} & React.ComponentPropsWithRef<'button'>): React.JSX.Element {
  return (
    <button
      type="button"
      {...triggerProps}
      // Why: a readout, not an action; the sibling segments' hover wash would promise a click.
      className={cn(
        'inline-flex cursor-default items-center gap-1 rounded px-1 py-0.5',
        // Why: dim while idle so the last reading isn't mistaken for live generation.
        emphasized ? 'text-foreground' : 'text-muted-foreground',
        className
      )}
      aria-label={translate(
        'auto.components.status.bar.AgentThroughputStatusSegment.ariaLabel',
        'Agent throughput, {{value}}',
        { value }
      )}
    >
      <Gauge className="size-3" />
      {iconOnly ? null : <span className="text-[11px] font-medium tabular-nums">{value}</span>}
    </button>
  )
}

/** tok/s of the focused pane's agent; a sample only changes when a model call completes. */
export function AgentThroughputStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element {
  const paneKey = useAppStore(selectActiveTerminalPaneKey)
  const sample = useAppStore((s) => (paneKey ? s.agentThroughputByPaneKey[paneKey] : undefined))
  const paneAgent = useAppStore((s) => (paneKey ? s.agentStatusByPaneKey[paneKey] : undefined))
  const working = paneAgent?.state === 'working'
  if (!sample) {
    const measuredFor = translate(
      'auto.components.status.bar.AgentThroughputStatusSegment.measuredFor',
      'Measured for Claude Code, Codex, Gemini CLI, OpenCode, MiMo Code. Estimated for Grok.'
    )
    // Why: an enabled item must always render, or "nothing" is indistinguishable from "off".
    const reason = resolveAgentThroughputPlaceholderReason({
      paneKey,
      agentType: paneAgent?.agentType
    })
    return (
      <Tooltip delayDuration={150}>
        <TooltipTrigger asChild>
          <Readout iconOnly={iconOnly} value={readoutLabel('n/a')} emphasized={false} />
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          <div className="space-y-0.5">
            <div>{placeholderHint(reason, paneAgent?.agentType)}</div>
            {reason === 'unmeasured-agent' ? (
              <div className="text-muted-foreground">{measuredFor}</div>
            ) : null}
          </div>
        </TooltipContent>
      </Tooltip>
    )
  }
  // Why: a leading "~" keeps an estimate from reading as a measured figure at a glance.
  const turnAverage =
    sample.turnMessageCount > 0
      ? computeTokensPerSecond(sample.turnOutputTokens, sample.turnGenerationMs)
      : null
  // Why: the bar shows the turn average — a single short message swings wildly — and keeps the
  // previous reading across a turn boundary until the new turn's first message completes.
  const prefix = sample.estimated ? '~' : ''
  const barValue = `${prefix}${formatTokensPerSecondValue(turnAverage ?? sample.tokensPerSecond)}`
  const lastValue = `${prefix}${formatTokensPerSecondValue(sample.tokensPerSecond)}`
  const readout = readoutLabel(barValue)
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <Readout iconOnly={iconOnly} value={readout} emphasized={working} />
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        <div className="space-y-0.5">
          <div>
            {turnAverage !== null
              ? translate(
                  'auto.components.status.bar.AgentThroughputStatusSegment.barTurnAverage',
                  'In the bar: {{value}} tok/s, this turn’s average over {{count}} model response(s)',
                  { value: barValue, count: sample.turnMessageCount }
                )
              : translate(
                  'auto.components.status.bar.AgentThroughputStatusSegment.barLastRequest',
                  'In the bar: {{value}} tok/s, last request (no message completed this turn yet)',
                  { value: barValue }
                )}
          </div>
          <div>
            {translate(
              'auto.components.status.bar.AgentThroughputStatusSegment.lastRequest',
              'Last request: {{value}} tok/s ({{tokens}} tokens in {{duration}})',
              {
                value: lastValue,
                tokens: formatTokens(sample.outputTokens),
                duration: formatGenerationDuration(sample.generationMs)
              }
            )}
          </div>
          <div className="text-muted-foreground">
            {[getAgentDisplayName(sample.agentType), sample.model].filter(Boolean).join(' · ')}
          </div>
          {sample.estimated ? (
            <div className="text-muted-foreground">
              {translate(
                'auto.components.status.bar.AgentThroughputStatusSegment.estimated',
                'Estimated from text length; Grok records no token counts.'
              )}
            </div>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
