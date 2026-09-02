import { Toggle } from '@/components/ui/toggle'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { aiVaultSearchUnindexedProviders } from '../../../../shared/ai-vault-search-coverage'
import type { AiVaultSearchCoverage } from '../../../../shared/ai-vault-search-types'
import { aiVaultAgentLabel } from '../../../../shared/ai-vault-types'

export function AiVaultSearchStatus({
  coverage,
  newestFirst,
  onNewestFirstChange
}: {
  coverage: AiVaultSearchCoverage | null
  newestFirst: boolean
  onNewestFirstChange: (newestFirst: boolean) => void
}): React.JSX.Element {
  return (
    <div className="mt-1.5 flex items-center justify-between gap-2">
      <div
        className={cn(
          'min-w-0 truncate text-[11px]',
          coverage && aiVaultSearchUnindexedProviders(coverage).length > 0
            ? 'text-destructive'
            : 'text-muted-foreground'
        )}
      >
        {coverage ? aiVaultSearchCoverageStatus(coverage) : null}
      </div>
      <Toggle
        variant="outline"
        size="sm"
        pressed={newestFirst}
        onPressedChange={onNewestFirstChange}
        className="h-6 shrink-0 px-2 text-[11px]"
      >
        {translate('auto.components.right.sidebar.AiVaultSearchStatus.newestFirst', 'Newest first')}
      </Toggle>
    </div>
  )
}

export function aiVaultSearchCoverageStatus(coverage: AiVaultSearchCoverage): string {
  const parts = [
    translate(
      'auto.components.right.sidebar.AiVaultSearchStatus.searchingSessions',
      'Searching {{value0}} sessions',
      { value0: coverage.sessionsIndexed.toLocaleString() }
    )
  ]
  if (coverage.backfill === 'running') {
    parts.push(
      translate(
        'auto.components.right.sidebar.AiVaultSearchStatus.indexingOlder',
        'indexing older sessions…'
      )
    )
  }
  if (coverage.filesPending > 0) {
    parts.push(
      translate(
        'auto.components.right.sidebar.AiVaultSearchStatus.filesPending',
        '{{value0}} changed files pending',
        { value0: coverage.filesPending.toLocaleString() }
      )
    )
  }
  for (const provider of aiVaultSearchUnindexedProviders(coverage)) {
    parts.push(
      translate(
        'auto.components.right.sidebar.AiVaultSearchStatus.providerNotIndexed',
        '{{value0}} not indexed',
        { value0: aiVaultAgentLabel(provider.agent) }
      )
    )
  }
  return parts.join(' · ')
}
