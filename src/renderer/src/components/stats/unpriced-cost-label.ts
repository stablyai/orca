import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

type CostSummary = { estimatedCostUsd: number | null; hasUnpricedModels: boolean }

export function unpricedCostLabel(
  label: string,
  summary: CostSummary | null,
  t: Translate = translate
): string {
  // "Excludes" promises a remainder, so it only qualifies a total that exists.
  if (!summary?.hasUnpricedModels || summary.estimatedCostUsd === null) {
    return label
  }
  // Why: the key keeps its original Codex namespace so its existing translations still apply.
  return `${label} ${t('auto.components.stats.CodexUsagePane.costExcludesUnpricedModels', '• excludes unpriced models')}`
}
