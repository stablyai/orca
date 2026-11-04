import React from 'react'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type {
  WorkflowMetric,
  WorkflowMetrics
} from '../../../../../shared/workflow/workflow-metrics'
import type { WorkflowRun } from '../../../../../shared/workflow/workflow-run-types'
import { formatWorkflowDuration } from '../workflow-status-style'
import { saveWorkflowTextFile } from '../workflow-file-export'
import { getIntlLocale, translate } from '@/i18n/i18n'

const SOURCE_LABEL: Record<WorkflowMetric['source'], string> = {
  measured: 'measured',
  estimated: 'estimated',
  provider: 'provider-reported',
  unavailable: 'unavailable'
}

function Tile({
  label,
  value,
  source
}: {
  label: string
  value: string
  source?: WorkflowMetric['source']
}) {
  return (
    <div className="min-w-32 rounded-md border border-border px-3 py-2">
      <div className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-[15px] font-medium tabular-nums">{value}</div>
      {source ? <div className="text-3xs text-muted-foreground">{SOURCE_LABEL[source]}</div> : null}
    </div>
  )
}

const ms = (metric: WorkflowMetric): string => formatWorkflowDuration(metric.value)
const num = (metric: WorkflowMetric): string =>
  metric.value === null ? '—' : metric.value.toLocaleString(getIntlLocale())

function metricsCsv(metrics: WorkflowMetrics): string {
  const header =
    'nodeId,label,agent,requestedModel,effectiveModel,attempts,retries,executionMs,waitMs,communicationWaitMs,messagesSent,messagesReceived,bytesSent,estimatedTokensSent,outcome'
  const rows = metrics.nodes.map((node) =>
    [
      node.nodeId,
      node.label,
      node.agent,
      node.requestedModel,
      node.effectiveModel,
      node.attempts,
      node.retries,
      node.executionMs.value,
      node.waitMs.value,
      node.communicationWaitMs.value,
      node.messagesSent,
      node.messagesReceived,
      node.bytesSent,
      node.estimatedTokensSent.value,
      node.outcome
    ]
      .map((value) => {
        const text = value === null || value === undefined ? '' : String(value)
        return /[",\n]/.test(text) || /^[=+\-@]/.test(text)
          ? `"${text.replace(/^([=+\-@])/, "'$1").replaceAll('"', '""')}"`
          : text
      })
      .join(',')
  )
  return [header, ...rows].join('\n')
}

export function WorkflowMetricsView({
  run,
  metrics
}: {
  run: WorkflowRun
  metrics: WorkflowMetrics
}): React.JSX.Element {
  return (
    <div className="h-full space-y-3 overflow-y-auto p-3 scrollbar-sleek">
      <div className="flex flex-wrap items-start gap-2">
        <Tile
          label={translate(
            'auto.components.workflows.execution.WorkflowMetricsView.4c332342be',
            'Duration'
          )}
          value={ms(metrics.durationMs)}
          source={metrics.durationMs.source}
        />
        <Tile
          label={translate(
            'auto.components.workflows.execution.WorkflowMetricsView.9f7e61e40b',
            'Tasks'
          )}
          value={`${metrics.tasksCompleted} done · ${metrics.tasksFailed} failed`}
        />
        <Tile
          label={translate(
            'auto.components.workflows.execution.WorkflowMetricsView.5a50332233',
            'Retries'
          )}
          value={String(metrics.retries)}
        />
        <Tile
          label={translate(
            'auto.components.workflows.execution.WorkflowMetricsView.1679c7f8a4',
            'Messages'
          )}
          value={`${metrics.messagesDelivered} · ${metrics.messagesRejected} refused`}
        />
        <Tile
          label={translate(
            'auto.components.workflows.execution.WorkflowMetricsView.88698ba291',
            'Bytes sent'
          )}
          value={metrics.bytesTransmitted.toLocaleString(getIntlLocale())}
          source="measured"
        />
        <Tile
          label={translate(
            'auto.components.workflows.execution.WorkflowMetricsView.8d0df4efca',
            'Tokens sent'
          )}
          value={`~${num(metrics.estimatedTokensTransmitted)}`}
          source="estimated"
        />
        <Tile
          label={translate(
            'auto.components.workflows.execution.WorkflowMetricsView.74f51312cd',
            'Model usage'
          )}
          value="—"
          source={metrics.modelUsage.source}
        />
        <div className="ml-auto flex gap-1">
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              void saveWorkflowTextFile(metricsCsv(metrics), `${run.presetName}-metrics`, 'csv')
            }
          >
            <Download />
            {translate('auto.components.workflows.execution.WorkflowMetricsView.b4151f43ce', 'CSV')}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              void saveWorkflowTextFile(
                JSON.stringify({ runId: run.id, presetId: run.presetId, metrics }, null, 2),
                `${run.presetName}-metrics`,
                'json'
              )
            }
          >
            <Download />
            {translate(
              'auto.components.workflows.execution.WorkflowMetricsView.69ad87949b',
              'JSON'
            )}
          </Button>
        </div>
      </div>
      <p className="text-2xs text-muted-foreground">
        {translate(
          'auto.components.workflows.execution.WorkflowMetricsView.5038fff81d',
          'Token counts estimate 4 bytes per token across routed payloads. Orca does not receive per-worker provider usage for terminal agents, so model usage is unavailable here.'
        )}
      </p>
      <table className="w-full text-left text-xs">
        <thead className="text-2xs uppercase tracking-wider text-muted-foreground">
          <tr className="border-b border-border">
            <th className="py-1.5 pr-3 font-semibold">
              {translate(
                'auto.components.workflows.execution.WorkflowMetricsView.43c8eebb9c',
                'Agent'
              )}
            </th>
            <th className="py-1.5 pr-3 font-semibold">
              {translate(
                'auto.components.workflows.execution.WorkflowMetricsView.561fab9a97',
                'Model'
              )}
            </th>
            <th className="py-1.5 pr-3 font-semibold">
              {translate(
                'auto.components.workflows.execution.WorkflowMetricsView.7377929744',
                'Attempts'
              )}
            </th>
            <th className="py-1.5 pr-3 font-semibold">
              {translate(
                'auto.components.workflows.execution.WorkflowMetricsView.5449ba0fcd',
                'Ran'
              )}
            </th>
            <th className="py-1.5 pr-3 font-semibold">
              {translate(
                'auto.components.workflows.execution.WorkflowMetricsView.9ffae5f212',
                'Waited'
              )}
            </th>
            <th className="py-1.5 pr-3 font-semibold">
              {translate(
                'auto.components.workflows.execution.WorkflowMetricsView.13ca15196a',
                'Held input'
              )}
            </th>
            <th className="py-1.5 pr-3 font-semibold">
              {translate(
                'auto.components.workflows.execution.WorkflowMetricsView.b9a4568c8e',
                'Sent / received'
              )}
            </th>
            <th className="py-1.5 font-semibold">
              {translate(
                'auto.components.workflows.execution.WorkflowMetricsView.797d08e54c',
                'Result'
              )}
            </th>
          </tr>
        </thead>
        <tbody>
          {metrics.nodes.map((node) => (
            <tr key={node.nodeId} className="border-b border-border/60">
              <td className="py-1.5 pr-3 font-medium">{node.label}</td>
              <td className="py-1.5 pr-3 text-muted-foreground">
                {node.agent} ·{' '}
                {node.effectiveModel ??
                  node.requestedModel ??
                  translate(
                    'auto.components.workflows.execution.WorkflowMetricsView.744d0b18cb',
                    'default'
                  )}
              </td>
              <td className="py-1.5 pr-3 tabular-nums">{node.attempts}</td>
              <td className="py-1.5 pr-3 tabular-nums">{ms(node.executionMs)}</td>
              <td className="py-1.5 pr-3 tabular-nums">{ms(node.waitMs)}</td>
              <td className="py-1.5 pr-3 tabular-nums">{ms(node.communicationWaitMs)}</td>
              <td className="py-1.5 pr-3 tabular-nums">
                {node.messagesSent} / {node.messagesReceived}
              </td>
              <td className="py-1.5 text-muted-foreground">{node.outcome}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="w-full text-left text-xs">
        <thead className="text-2xs uppercase tracking-wider text-muted-foreground">
          <tr className="border-b border-border">
            <th className="py-1.5 pr-3 font-semibold">
              {translate(
                'auto.components.workflows.execution.WorkflowMetricsView.483d058989',
                'Route'
              )}
            </th>
            <th className="py-1.5 pr-3 font-semibold">
              {translate(
                'auto.components.workflows.execution.WorkflowMetricsView.33bdcf98e8',
                'Delivered'
              )}
            </th>
            <th className="py-1.5 pr-3 font-semibold">
              {translate(
                'auto.components.workflows.execution.WorkflowMetricsView.496a984f1a',
                'Refused'
              )}
            </th>
            <th className="py-1.5 pr-3 font-semibold">
              {translate(
                'auto.components.workflows.execution.WorkflowMetricsView.53aacd960f',
                'Held'
              )}
            </th>
            <th className="py-1.5 pr-3 font-semibold">
              {translate(
                'auto.components.workflows.execution.WorkflowMetricsView.31b722fbec',
                'Bytes'
              )}
            </th>
            <th className="py-1.5 font-semibold">
              {translate(
                'auto.components.workflows.execution.WorkflowMetricsView.d39743e7b9',
                'Tokens (est.)'
              )}
            </th>
          </tr>
        </thead>
        <tbody>
          {metrics.edges.map((edge) => (
            <tr key={edge.edgeId} className="border-b border-border/60">
              <td className="py-1.5 pr-3 font-medium">{edge.name || edge.edgeId}</td>
              <td className="py-1.5 pr-3 tabular-nums">{edge.delivered}</td>
              <td className="py-1.5 pr-3 tabular-nums">{edge.rejected}</td>
              <td className="py-1.5 pr-3 tabular-nums">{edge.held}</td>
              <td className="py-1.5 pr-3 tabular-nums">
                {edge.bytes.toLocaleString(getIntlLocale())}
              </td>
              <td className="py-1.5 tabular-nums">~{num(edge.estimatedTokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
