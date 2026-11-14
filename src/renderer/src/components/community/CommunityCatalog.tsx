import { useState } from 'react'
import { ArrowDown, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type {
  CommunityFeatureAction,
  CommunityFeaturesSnapshot
} from '../../../../shared/community-features'
import type { CommunityPage, CommunityQuery } from '../../../../shared/community-operations'
import { CommunitySearchFilters } from './CommunitySearchFilters'
import { CommunityProposalCard } from './CommunityProposalCard'
export function CommunityCatalog({
  page,
  query,
  onQuery,
  onOpen,
  mutate,
  loadMore,
  loading,
  onChooseAccount
}: {
  page: CommunityPage
  query: CommunityQuery
  onQuery: (query: CommunityQuery) => void
  onOpen: (n: number) => void
  mutate: (action: CommunityFeatureAction) => Promise<CommunityFeaturesSnapshot>
  loadMore: () => Promise<void>
  loading: boolean
  onChooseAccount: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const [allAreas, setAllAreas] = useState(false)
  const features = Object.values(page.personal.features)
  const unsupported = !!(query.inclusion || query.readiness) && page.filterVersion !== 1
  const rows = (query.mine && !page.viewer) || unsupported ? [] : page.rows
  const hasFilters = !!(
    query.query ||
    query.mine ||
    query.inclusion ||
    query.readiness ||
    query.area ||
    query.kind ||
    query.images ||
    (query.view && query.view !== 'explore')
  )
  const tabs = [
    { id: 'explore', label: t('community.explore', 'Explore'), count: null },
    {
      id: 'saved',
      label: t('community.saved', 'Saved'),
      count: features.filter((row) => row.savedAt).length
    },
    {
      id: 'viewed',
      label: t('community.viewed', 'Viewed'),
      count: features.filter((row) => row.visit).length
    }
  ] as const
  return (
    <div className="space-y-6 max-sm:space-y-4">
      <ToggleGroup
        type="single"
        variant="segmented-card"
        value={query.view ?? 'explore'}
        onValueChange={(view) => {
          if (view === 'explore' || view === 'saved' || view === 'viewed') {
            onQuery({ ...query, view })
          }
        }}
        aria-label={t('community.proposalViews', 'Proposal views')}
        className="w-fit grid-cols-3 max-sm:w-full"
      >
        {tabs.map((tab) => (
          <ToggleGroupItem value={tab.id} key={tab.id}>
            {tab.label}
            {tab.count !== null && <Badge variant="secondary">{tab.count}</Badge>}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <CommunitySearchFilters
        page={page}
        query={query}
        onQuery={onQuery}
        onChooseAccount={onChooseAccount}
      />
      {!hasFilters && (
        <>
          <div className="grid grid-cols-3 gap-3">
            {[
              {
                name: t('community.unmergedCount', 'Unmerged PRs'),
                count: page.summary.total,
                kind: undefined
              },
              ...page.summary.kinds
                .filter((row) => ['Features', 'Fixes'].includes(row.name))
                .map((row) => ({ ...row, kind: row.name }))
            ].map((item) => (
              <Button
                key={item.name}
                variant={query.kind === item.kind ? 'secondary' : 'outline'}
                className="h-auto justify-between text-left whitespace-normal"
                aria-pressed={query.kind === item.kind}
                onClick={() => onQuery({ ...query, kind: item.kind })}
              >
                <span>
                  <span className="block text-xs font-normal text-muted-foreground">
                    {item.name}
                  </span>
                  <span className="mt-2 block text-2xl font-semibold">
                    {item.count.toLocaleString(locale)}
                  </span>
                </span>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground max-sm:hidden" />
              </Button>
            ))}
          </div>
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">{t('community.areas', 'Explore by area')}</h2>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAllAreas(!allAreas)}
                aria-expanded={allAreas}
              >
                {allAreas
                  ? t('community.less', 'Show fewer')
                  : `${page.summary.areas.length} ${t('community.inferredAreas', 'inferred areas')}`}
              </Button>
            </div>
            <div
              className={`grid gap-2 sm:grid-cols-2 lg:grid-cols-4 ${allAreas ? '' : 'max-sm:hidden'}`}
            >
              <Button
                size="sm"
                className="h-auto justify-between"
                variant={!query.area ? 'secondary' : 'outline'}
                onClick={() => onQuery({ ...query, area: undefined })}
              >
                {t('community.allAreas', 'All areas')}
              </Button>
              {page.summary.areas.slice(0, allAreas ? undefined : 3).map((area) => (
                <Button
                  key={area.name}
                  size="sm"
                  className="h-auto justify-between"
                  variant={query.area === area.name ? 'secondary' : 'outline'}
                  aria-pressed={query.area === area.name}
                  onClick={() =>
                    onQuery({ ...query, area: query.area === area.name ? undefined : area.name })
                  }
                >
                  {area.name}
                  <Badge variant="secondary">{area.count.toLocaleString(locale)}</Badge>
                </Button>
              ))}
            </div>
            <p className="mt-2 text-2xs text-muted-foreground max-sm:hidden">
              {t(
                'community.inferenceNote',
                'Areas come from PR titles. Images come from author links.'
              )}
            </p>
          </div>
        </>
      )}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {((query.mine && !page.viewer) || unsupported ? 0 : page.total).toLocaleString(locale)}{' '}
          {t('community.results', 'matching proposals')}
        </span>
        {(query.query ||
          query.area ||
          query.kind ||
          query.images ||
          query.mine ||
          query.inclusion ||
          query.readiness) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onQuery({ view: query.view, limit: 12 })}
          >
            {t('community.clearFilters', 'Clear filters')}
          </Button>
        )}
      </div>
      {rows.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((pr) => (
            <CommunityProposalCard
              key={pr.number}
              pr={pr}
              feature={page.personal.features[pr.number]}
              includedImageUrls={page.runningBuild?.changes
                .filter((change) => change.pullRequest?.number === pr.number)
                .flatMap((change) => change.imageUrls ?? [])}
              includedTitles={page.runningBuild?.changes
                .filter((change) => change.pullRequest?.number === pr.number)
                .map((change) => change.title)}
              onOpen={() => onOpen(pr.number)}
              onSave={() =>
                mutate({
                  action: page.personal.features[pr.number]?.savedAt ? 'unsave' : 'save',
                  number: pr.number
                }).catch(() => {})
              }
            />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          {t(
            'community.empty',
            'No proposals match this view. Change a filter or refresh GitHub data.'
          )}
        </div>
      )}
      {page.nextOffset !== null && !(query.mine && !page.viewer) && !unsupported && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => void loadMore()} disabled={loading}>
            <ArrowDown className="size-4" />
            {loading ? t('community.loading', 'Loading…') : t('community.loadMore', 'Load more')}
          </Button>
        </div>
      )}
    </div>
  )
}
