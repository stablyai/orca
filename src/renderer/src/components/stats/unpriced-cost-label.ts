import { translate } from '@/i18n/i18n'

type CostSummary = { estimatedCostUsd: number | null; hasUnpricedModels: boolean }

/** Qualifies a cost card label when its total leaves out tokens from models with no price. */
export function unpricedCostLabel(label: string, summary: CostSummary | null): string {
  // "Excludes" promises a remainder, so it only qualifies a total that exists.
  if (!summary?.hasUnpricedModels || summary.estimatedCostUsd === null) {
    return label
  }
  // Why: the key keeps its original Codex namespace so its existing translations still apply.
  return `${label} ${translate('auto.components.stats.CodexUsagePane.costExcludesUnpricedModels', '• excludes unpriced models')}`
}
