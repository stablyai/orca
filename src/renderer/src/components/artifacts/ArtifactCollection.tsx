import { useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { ArtifactListItem } from '../../../../shared/artifacts'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { clampArtifactListSearchQuery, filterArtifactsBySearchQuery } from './artifact-list-search'
import { ArtifactListRows } from './ArtifactListRows'
import { ArtifactListTableHeader } from './ArtifactListTableHeader'
import { ArtifactListToolbar } from './ArtifactListToolbar'
import { LIST_TABLE_CONTAINER_CLASS } from '@/lib/list-table-layout'

export function ArtifactCollection({
  artifacts,
  deletingId,
  selectedSlug,
  selectArtifact,
  deleteArtifact,
  hasMore,
  loadingMore,
  loadMore,
  onRefresh,
  isRefreshing
}: {
  artifacts: readonly ArtifactListItem[]
  deletingId: string | null
  selectedSlug: string | null
  selectArtifact: (slug: string) => void
  deleteArtifact: (item: ArtifactListItem) => void
  hasMore: boolean
  loadingMore: boolean
  loadMore: () => void
  onRefresh: () => void
  isRefreshing: boolean
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  // Clamp before state/filtering so multi-MB pastes cannot reach either.
  const onQueryChange = (next: string): void => setQuery(clampArtifactListSearchQuery(next))
  const matches = useMemo(() => filterArtifactsBySearchQuery(artifacts, query), [artifacts, query])
  // Why: state, not a ref — the windowed rows need the scroller on their own mount pass.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 pb-4 md:px-5">
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <ArtifactListToolbar
          query={query}
          onQueryChange={onQueryChange}
          onRefresh={onRefresh}
          isRefreshing={isRefreshing}
        />
        <div
          ref={setScrollElement}
          className={cn('scrollbar-sleek min-h-0 flex-1 overflow-auto', LIST_TABLE_CONTAINER_CLASS)}
        >
          <ArtifactListTableHeader />
          {/* Avoid w-fit row bands: they extend hover/selection washes to scroll width beyond the viewport. */}
          {matches.length > 0 ? (
            <ArtifactListRows
              artifacts={matches}
              deletingId={deletingId}
              selectedSlug={selectedSlug}
              scrollElement={scrollElement}
              hasMore={hasMore}
              selectArtifact={selectArtifact}
              deleteArtifact={deleteArtifact}
            />
          ) : (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {translate('auto.components.artifacts.ArtifactCollection.noMatches', 'No matches')}
            </p>
          )}
          {hasMore ? (
            <div className="border-t border-border/50 p-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full"
                disabled={loadingMore}
                onClick={loadMore}
              >
                {loadingMore ? <Loader2 className="animate-spin" /> : null}
                {translate('auto.components.artifacts.ArtifactCollection.loadMore', 'Load more')}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
