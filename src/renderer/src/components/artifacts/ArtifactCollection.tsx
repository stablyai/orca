import { useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { ArtifactListItem } from '../../../../shared/artifacts/artifacts'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { clampArtifactListSearchQuery, filterArtifactsBySearchQuery } from './artifact-list-search'
import { ArtifactListRows } from './ArtifactListRows'
import { ArtifactListTableHeader } from './ArtifactListTableHeader'
import { ArtifactListSearchField } from './ArtifactListSearchField'
import { RailPageBody, RailPageScroll } from '@/components/rail-page/RailPage'
import { RailPageToolbar } from '@/components/rail-page/RailPageToolbar'
import { RailPageSearch } from '@/components/rail-page/RailPageSearch'

export function ArtifactCollection({
  artifacts,
  deletingId,
  selectedSlug,
  selectArtifact,
  deleteArtifact,
  hasMore,
  loadingMore,
  loadMore,
  notice
}: {
  artifacts: readonly ArtifactListItem[]
  deletingId: string | null
  selectedSlug: string | null
  selectArtifact: (slug: string) => void
  deleteArtifact: (item: ArtifactListItem) => void
  hasMore: boolean
  loadingMore: boolean
  loadMore: () => void
  /** The page's notice band (load error), drawn under the toolbar. */
  notice?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  // Clamp before state/filtering so multi-MB pastes cannot reach either.
  const onQueryChange = (next: string): void => setQuery(clampArtifactListSearchQuery(next))
  const matches = useMemo(() => filterArtifactsBySearchQuery(artifacts, query), [artifacts, query])
  // Why: state, not a ref — the windowed rows need the scroller on their own mount pass.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)

  return (
    <>
      <RailPageToolbar
        end={
          <RailPageSearch inputRef={searchInputRef} hasValue={query !== ''} focusTarget="page">
            <ArtifactListSearchField
              inputRef={searchInputRef}
              query={query}
              onQueryChange={onQueryChange}
              onClear={() => onQueryChange('')}
            />
          </RailPageSearch>
        }
      />
      {notice}
      <RailPageBody>
        {/* Not padded: rows pad from the page gutter so hairlines and sticky cells share the page edges. */}
        <RailPageScroll
          ref={setScrollElement}
          className="scrollbar-sleek min-h-0 flex-1 overflow-auto"
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
              {t('auto.components.artifacts.ArtifactCollection.noMatches', 'No matches')}
            </p>
          )}
          {hasMore ? (
            <div className="border-t border-border/50 rail-page-row-gutter py-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full"
                disabled={loadingMore}
                onClick={loadMore}
              >
                {loadingMore ? <Loader2 className="animate-spin" /> : null}
                {t('auto.components.artifacts.ArtifactCollection.loadMore', 'Load more')}
              </Button>
            </div>
          ) : null}
        </RailPageScroll>
      </RailPageBody>
    </>
  )
}
