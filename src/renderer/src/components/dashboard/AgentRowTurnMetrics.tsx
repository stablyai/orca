import React from 'react'
import { agentTurnUsagePromptTokens } from '../../../../shared/agent-turn-usage'
import { formatNativeChatDuration } from '../../../../shared/native-chat-turn-status'
import { DiffLineCounts } from '@/components/right-sidebar/source-control/listing/diff-line-counts'
import { formatTokens } from '@/components/stats/usage-formatters'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAgentRowJcodeDiffStat } from './use-agent-row-jcode-diff-stat'
import type { DashboardAgentRow } from './useDashboardData'

export function AgentRowTurnMetrics({
  agent,
  focused,
  className
}: {
  agent: DashboardAgentRow
  focused?: boolean
  className?: string
}): React.JSX.Element | null {
  const diff = useAgentRowJcodeDiffStat(agent)
  if (agent.rowSource === 'subagent' || agent.childRow) {
    return null
  }
  const usage = agent.entry.lastTurnUsage
  const hasDiff = diff && (diff.added > 0 || diff.removed > 0)
  if (!usage && !hasDiff) {
    return null
  }
  const usageTooltip = usage
    ? [
        translate('auto.components.agentRowMetrics.usageHeading', 'Last turn'),
        translate('auto.components.agentRowMetrics.usageInput', 'Input: {{value}}', {
          value: usage.inputTokens.toLocaleString()
        }),
        ...(usage.cacheReadTokens !== undefined
          ? [
              translate('auto.components.agentRowMetrics.usageCacheRead', 'Cache read: {{value}}', {
                value: usage.cacheReadTokens.toLocaleString()
              })
            ]
          : []),
        ...(usage.cacheWriteTokens !== undefined
          ? [
              translate(
                'auto.components.agentRowMetrics.usageCacheWrite',
                'Cache write: {{value}}',
                {
                  value: usage.cacheWriteTokens.toLocaleString()
                }
              )
            ]
          : []),
        translate('auto.components.agentRowMetrics.usageOutput', 'Output: {{value}}', {
          value: usage.outputTokens.toLocaleString()
        }),
        ...(usage.durationMs !== undefined
          ? [
              translate('auto.components.agentRowMetrics.usageDuration', 'Duration: {{value}}', {
                value: formatNativeChatDuration(usage.durationMs / 1000)
              })
            ]
          : [])
      ].join('\n')
    : undefined

  return (
    // Wrap oversized chips below the clipped line to avoid cutting glyphs.
    <span
      data-agent-turn-metrics
      className={cn(
        'flex h-3.5 min-w-0 flex-wrap gap-x-1.5 overflow-hidden text-3xs leading-3.5 before:h-full before:-mr-1.5',
        className
      )}
    >
      {usage && (
        <span
          className={cn(
            'shrink-0 whitespace-nowrap font-mono text-3xs tabular-nums',
            focused ? 'text-foreground/70' : 'text-muted-foreground/70'
          )}
          title={usageTooltip}
        >
          ↑{formatTokens(agentTurnUsagePromptTokens(usage))} ↓{formatTokens(usage.outputTokens)}
        </span>
      )}
      {hasDiff && (
        <span
          className="shrink-0 whitespace-nowrap"
          title={translate(
            'auto.components.agentRowMetrics.diffTitle',
            'Whole session: +{{added}} -{{removed}} lines changed, not just this turn',
            { added: diff.added.toLocaleString(), removed: diff.removed.toLocaleString() }
          )}
        >
          <DiffLineCounts added={diff.added} removed={diff.removed} />
        </span>
      )}
    </span>
  )
}
