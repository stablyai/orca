import type {
  OrchestrationCostReport,
  OrchestrationReportMetrics,
  OrchestrationReportTask
} from '../../../../shared/orchestration-cost-report'

export type OrchestrationNodeDisplay = {
  id: string
  depth: number
  status: string
  elapsed: string
  tokens: string
  cost: string | null
}

const PROVIDER_LABELS: Record<
  OrchestrationCostReport['totals']['usage']['providers'][number]['provider'],
  string
> = {
  codex: 'Codex',
  claude: 'Claude',
  opencode: 'OpenCode'
}

export function formatOrchestrationProvider(
  provider: OrchestrationCostReport['totals']['usage']['providers'][number]['provider']
): string {
  return PROVIDER_LABELS[provider]
}

export function formatOrchestrationTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k`
  }
  return String(tokens)
}

export function formatOrchestrationCost(cost: number | null): string | null {
  if (cost === null || !Number.isFinite(cost)) {
    return null
  }
  if (cost > 0 && cost < 0.01) {
    return '<$0.01'
  }
  return `$${cost.toFixed(cost >= 100 ? 0 : 2)}`
}

export function formatOrchestrationElapsed(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) {
    return '—'
  }
  const seconds = Math.max(0, Math.round(milliseconds / 1_000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`
  }
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function sumOrchestrationMetrics(metrics: readonly OrchestrationReportMetrics[]): {
  tokens: number
  cost: number | null
  costStatus: OrchestrationReportMetrics['costStatus']
} {
  const tokens = metrics.reduce((sum, item) => sum + item.totalTokens, 0)
  const knownCosts = metrics.flatMap((item) =>
    item.estimatedCostUsd === null ? [] : [item.estimatedCostUsd]
  )
  const costStatus =
    knownCosts.length === 0
      ? 'unavailable'
      : metrics.every((item) => item.costStatus === 'known')
        ? 'known'
        : 'partial'
  return {
    tokens,
    cost: knownCosts.length > 0 ? knownCosts.reduce((sum, value) => sum + value, 0) : null,
    costStatus
  }
}

export function getOrchestrationReportTotals(report: OrchestrationCostReport): {
  tokens: number
  cost: number | null
  costStatus: OrchestrationReportMetrics['costStatus']
} {
  return sumOrchestrationMetrics(report.totals.usage.providers.map((item) => item.metrics))
}

function nodeDisplay(task: OrchestrationReportTask, depth: number): OrchestrationNodeDisplay {
  const metrics = sumOrchestrationMetrics(task.usage.rolledUp.providers.map((item) => item.metrics))
  return {
    id: task.id,
    depth,
    status: task.status,
    elapsed: formatOrchestrationElapsed(task.elapsed.rolledUp.milliseconds),
    tokens: formatOrchestrationTokens(metrics.tokens),
    cost: formatOrchestrationCost(metrics.cost)
  }
}

export function getOrchestrationNodeDisplay(
  report: OrchestrationCostReport,
  limit = 24
): { nodes: OrchestrationNodeDisplay[]; omitted: number } {
  const byId = new Map(report.graph.tasks.map((task) => [task.id, task]))
  const visited = new Set<string>()
  const nodes: OrchestrationNodeDisplay[] = []
  const visit = (id: string, depth: number): void => {
    if (visited.has(id) || nodes.length >= limit) {
      return
    }
    const task = byId.get(id)
    if (!task) {
      return
    }
    visited.add(id)
    nodes.push(nodeDisplay(task, depth))
    for (const childId of task.childIds) {
      visit(childId, depth + 1)
    }
  }
  for (const rootId of report.graph.rootTaskIds) {
    visit(rootId, 0)
  }
  for (const task of report.graph.tasks) {
    visit(task.id, 0)
  }
  return { nodes, omitted: Math.max(0, report.graph.tasks.length - nodes.length) }
}

export function orchestrationReportNeedsDisclosure(report: OrchestrationCostReport): boolean {
  return (
    report.completeness.status === 'partial' ||
    report.totals.elapsed.status !== 'available' ||
    report.totals.usage.attributionCertainty === 'unavailable' ||
    getOrchestrationReportTotals(report).costStatus !== 'known' ||
    report.completeness.providerSessions.some(
      (provider) => provider.completeness !== 'complete' || provider.status !== 'available'
    ) ||
    report.attribution.unlinked.length > 0 ||
    report.attribution.ambiguous.length > 0
  )
}
