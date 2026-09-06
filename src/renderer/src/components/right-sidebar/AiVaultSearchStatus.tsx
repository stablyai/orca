import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { aiVaultSearchUnindexedProviders } from '../../../../shared/ai-vault-search-coverage'
import type { AiVaultSearchCoverage } from '../../../../shared/ai-vault-search-types'
import { aiVaultAgentLabel } from '../../../../shared/ai-vault-types'

const SORT_TOGGLE_ITEM_CLASS =
  'h-6 min-h-6 min-w-0 shrink-0 border border-transparent bg-transparent px-2 text-[11px] font-medium leading-none text-muted-foreground shadow-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[state=on]:border-foreground/20 data-[state=on]:bg-foreground/10 data-[state=on]:text-foreground data-[state=on]:shadow-xs'

export function AiVaultSearchStatus({
  coverage,
  hitCount,
  hasQuery,
  newestFirst,
  onNewestFirstChange
}: {
  coverage: AiVaultSearchCoverage | null
  /** Matches currently rendered; only meaningful while a query is active. */
  hitCount: number
  hasQuery: boolean
  newestFirst: boolean
  onNewestFirstChange: (newestFirst: boolean) => void
}): React.JSX.Element | null {
  const unindexed = coverage ? aiVaultSearchUnindexedProviders(coverage) : []
  const status = coverage ? aiVaultSearchCoverageStatus(coverage, { hitCount, hasQuery }) : null
  if (!status && unindexed.length === 0) {
    return null
  }
  return (
    <div className="mt-1.5 flex items-center justify-between gap-2">
      <div className="min-w-0 truncate text-[11px] text-muted-foreground">
        {status}
        {unindexed.length > 0 ? (
          <span className={cn(status ? 'ml-1' : '', 'text-destructive')}>
            {unindexed
              .map((provider) =>
                translate(
                  'auto.components.right.sidebar.AiVaultSearchStatus.providerNotIndexed',
                  '{{value0}} not indexed',
                  { value0: aiVaultAgentLabel(provider.agent) }
                )
              )
              .join(' · ')}
          </span>
        ) : null}
      </div>
      {hasQuery ? (
        <ToggleGroup
          type="single"
          value={newestFirst ? 'newest' : 'relevance'}
          onValueChange={(value) => {
            if (value === 'newest' || value === 'relevance') {
              onNewestFirstChange(value === 'newest')
            }
          }}
          variant="outline"
          className="h-6 shrink-0 rounded-md border border-sidebar-border bg-sidebar-accent/35"
          aria-label={translate(
            'auto.components.right.sidebar.AiVaultSearchStatus.sortAriaLabel',
            'Sort search results'
          )}
        >
          <ToggleGroupItem value="relevance" className={SORT_TOGGLE_ITEM_CLASS}>
            {translate('auto.components.right.sidebar.AiVaultSearchStatus.relevance', 'Relevance')}
          </ToggleGroupItem>
          <ToggleGroupItem value="newest" className={SORT_TOGGLE_ITEM_CLASS}>
            {translate('auto.components.right.sidebar.AiVaultSearchStatus.newest', 'Newest')}
          </ToggleGroupItem>
        </ToggleGroup>
      ) : null}
    </div>
  )
}

/**
 * Three readings, in the order a user meets them: still building, building with
 * a query outstanding, and settled. Silent when the index is complete and the
 * box is empty — there is nothing to report.
 */
export function aiVaultSearchCoverageStatus(
  coverage: AiVaultSearchCoverage,
  { hitCount, hasQuery }: { hitCount: number; hasQuery: boolean }
): string | null {
  const preparing = coverage.backfill === 'running'
  if (!hasQuery) {
    return preparing
      ? translate(
          'auto.components.right.sidebar.AiVaultSearchStatus.searchableAndPreparing',
          '{{value0}} conversations searchable · preparing older ones…',
          { value0: coverage.sessionsIndexed.toLocaleString() }
        )
      : null
  }
  if (preparing) {
    return translate(
      'auto.components.right.sidebar.AiVaultSearchStatus.matchingIncomplete',
      '{{value0}} matching · still preparing',
      { value0: hitCount.toLocaleString() }
    )
  }
  return translate(
    'auto.components.right.sidebar.AiVaultSearchStatus.matchingInConversations',
    '{{value0}} matching · {{value1}} conversations',
    { value0: hitCount.toLocaleString(), value1: coverage.sessionsIndexed.toLocaleString() }
  )
}
