import React from 'react'
import { translate } from '@/i18n/i18n'
import type { OrchestrationCostReport } from '../../../../shared/orchestration-cost-report'
import {
  formatOrchestrationCost,
  formatOrchestrationElapsed,
  formatOrchestrationProvider,
  formatOrchestrationTokens,
  getOrchestrationNodeDisplay,
  getOrchestrationReportTotals
} from './orchestration-cost-display'

function SummaryValue({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="truncate text-xs font-medium tabular-nums text-foreground">{value}</div>
    </div>
  )
}

function DataQuality({
  report,
  stale
}: {
  report: OrchestrationCostReport
  stale: boolean
}): React.JSX.Element {
  const totals = getOrchestrationReportTotals(report)
  return (
    <div className="border-b border-border px-3 py-2 text-[11px]">
      <div className="mb-1 font-medium text-foreground">
        {translate(
          'auto.components.status.bar.OrchestrationUsageStatusSegment.dataQuality',
          'Data quality'
        )}
      </div>
      <div className="space-y-0.5 text-muted-foreground">
        {stale ? (
          <div>
            {translate(
              'auto.components.status.bar.OrchestrationUsageStatusSegment.staleDetail',
              'Stale: the latest refresh failed; values are from the last successful report.'
            )}
          </div>
        ) : null}
        <div>
          {report.completeness.status === 'complete'
            ? translate(
                'auto.components.status.bar.OrchestrationUsageStatusSegment.completeDetail',
                'Complete within the report row and provider-session limits.'
              )
            : translate(
                'auto.components.status.bar.OrchestrationUsageStatusSegment.partialDetail',
                'Partial: one or more report inputs were unavailable or truncated.'
              )}
        </div>
        <div>
          {report.totals.usage.attributionCertainty === 'inferred'
            ? translate(
                'auto.components.status.bar.OrchestrationUsageStatusSegment.inferredDetail',
                'Attribution is inferred from exact worktree and dispatch time intervals.'
              )
            : translate(
                'auto.components.status.bar.OrchestrationUsageStatusSegment.attributionUnavailableDetail',
                'Attribution unavailable: no provider usage could be linked to this run.'
              )}
        </div>
        <div>
          {translate(
            'auto.components.status.bar.OrchestrationUsageStatusSegment.attributionCounts',
            '{{value0}} unlinked · {{value1}} ambiguous sessions',
            {
              value0: report.attribution.unlinked.length,
              value1: report.attribution.ambiguous.length
            }
          )}
        </div>
        {totals.costStatus !== 'known' ? (
          <div>
            {totals.cost === null
              ? translate(
                  'auto.components.status.bar.OrchestrationUsageStatusSegment.costUnavailable',
                  'Cost unavailable: no attributable provider estimate was reported.'
                )
              : translate(
                  'auto.components.status.bar.OrchestrationUsageStatusSegment.costPartial',
                  'Cost partial: the estimate excludes providers without cost data.'
                )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function ProviderBreakdown({ report }: { report: OrchestrationCostReport }): React.JSX.Element {
  return (
    <div className="border-b border-border px-3 py-2">
      <div className="mb-1 text-[11px] font-medium text-foreground">
        {translate(
          'auto.components.status.bar.OrchestrationUsageStatusSegment.providers',
          'Providers'
        )}
      </div>
      {report.totals.usage.providers.length === 0 ? (
        <div className="text-[11px] text-muted-foreground">
          {translate(
            'auto.components.status.bar.OrchestrationUsageStatusSegment.noAttributedUsage',
            'No attributed provider usage is available.'
          )}
        </div>
      ) : (
        <div className="space-y-1">
          {report.totals.usage.providers.map((provider) => (
            <div
              key={provider.provider}
              className="flex items-center justify-between gap-3 text-[11px]"
            >
              <span className="text-muted-foreground">
                {formatOrchestrationProvider(provider.provider)}
              </span>
              <span className="tabular-nums text-foreground">
                {formatOrchestrationTokens(provider.metrics.totalTokens)}
                {provider.metrics.estimatedCostUsd !== null
                  ? ` · ${formatOrchestrationCost(provider.metrics.estimatedCostUsd)}`
                  : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function NodeBreakdown({ report }: { report: OrchestrationCostReport }): React.JSX.Element {
  const display = getOrchestrationNodeDisplay(report)
  return (
    <div className="px-3 py-2">
      <div className="mb-1 text-[11px] font-medium text-foreground">
        {translate(
          'auto.components.status.bar.OrchestrationUsageStatusSegment.nodes',
          'Branch and node breakdown'
        )}
      </div>
      <div className="scrollbar-sleek max-h-48 space-y-0.5 overflow-y-auto">
        {display.nodes.map((node) => (
          <div
            key={node.id}
            className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 text-[11px]"
            style={{ paddingLeft: `${Math.min(node.depth, 6) * 12}px` }}
          >
            <span className="truncate font-mono text-muted-foreground">
              {node.id} · {node.status}
            </span>
            <span className="tabular-nums text-muted-foreground">{node.elapsed}</span>
            <span className="tabular-nums text-foreground">
              {node.tokens}
              {node.cost ? ` · ${node.cost}` : ''}
            </span>
          </div>
        ))}
        {display.nodes.length === 0 ? (
          <div className="text-[11px] text-muted-foreground">
            {translate(
              'auto.components.status.bar.OrchestrationUsageStatusSegment.noNodes',
              'No task nodes are available.'
            )}
          </div>
        ) : null}
        {display.omitted > 0 ? (
          <div className="text-[11px] text-muted-foreground">
            {translate(
              'auto.components.status.bar.OrchestrationUsageStatusSegment.nodesOmitted',
              '{{value0}} additional nodes omitted.',
              { value0: display.omitted }
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function OrchestrationUsageReportDetails({
  report,
  stale,
  source
}: {
  report: OrchestrationCostReport
  stale: boolean
  source: 'live' | 'lineage'
}): React.JSX.Element {
  const totals = getOrchestrationReportTotals(report)
  const generatedAt = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium'
  }).format(new Date(report.generatedAt))
  return (
    <>
      <div className="grid grid-cols-3 gap-3 border-b border-border px-3 py-2">
        <SummaryValue
          label={translate(
            'auto.components.status.bar.OrchestrationUsageStatusSegment.elapsed',
            'Elapsed'
          )}
          value={formatOrchestrationElapsed(report.totals.elapsed.milliseconds)}
        />
        <SummaryValue
          label={translate(
            'auto.components.status.bar.OrchestrationUsageStatusSegment.attributedTokens',
            'Attributed tokens'
          )}
          value={formatOrchestrationTokens(totals.tokens)}
        />
        <SummaryValue
          label={translate(
            'auto.components.status.bar.OrchestrationUsageStatusSegment.estimatedCost',
            'Estimated cost'
          )}
          value={formatOrchestrationCost(totals.cost) ?? '—'}
        />
      </div>
      <div className="space-y-1 border-b border-border px-3 py-2 text-[11px]">
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">
            {translate('auto.components.status.bar.OrchestrationUsageStatusSegment.run', 'Run')}
          </span>
          <span className="break-all text-right font-mono text-foreground">{report.run.id}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">
            {translate(
              'auto.components.status.bar.OrchestrationUsageStatusSegment.generated',
              'Report generated'
            )}
          </span>
          <span className="text-right text-foreground">{generatedAt}</span>
        </div>
        <div className="text-muted-foreground">
          {source === 'live'
            ? translate(
                'auto.components.status.bar.OrchestrationUsageStatusSegment.liveSelection',
                'Selected from live orchestration activity in this workspace.'
              )
            : translate(
                'auto.components.status.bar.OrchestrationUsageStatusSegment.lineageSelection',
                'Selected from instance-verified workspace lineage; the run may be completed.'
              )}
        </div>
      </div>
      <DataQuality report={report} stale={stale} />
      <ProviderBreakdown report={report} />
      <NodeBreakdown report={report} />
    </>
  )
}
