import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { ArtifactListItem } from '../../../../shared/artifacts/artifacts'
import { Button } from '@/components/ui/button'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { clampArtifactListSearchQuery, filterArtifactsBySearchQuery } from './artifact-list-search'
import {
  artifactTypeOptions,
  countArtifactListFilters,
  DEFAULT_ARTIFACT_LIST_SORT,
  EMPTY_ARTIFACT_LIST_FILTER,
  filterArtifactList,
  nextArtifactListSort,
  sortArtifactList,
  type ArtifactListFilter,
  type ArtifactListSort
} from './artifact-list-view'
import { ArtifactListFilterMenu, ArtifactListFilterPills } from './ArtifactListFilterMenu'
import { ArtifactListRows } from './ArtifactListRows'
import { ArtifactListSelectionBar } from './ArtifactListSelectionBar'
import { ArtifactListTableHeader } from './ArtifactListTableHeader'
import { ArtifactListSearchField } from './ArtifactListSearchField'
import { useArtifactListSelection } from './use-artifact-list-selection'
import { RailPageBody, RailPageNotice, RailPageScroll } from '@/components/rail-page/RailPage'
import { RailPageToolbar } from '@/components/rail-page/RailPageToolbar'
import { RailPageSearch } from '@/components/rail-page/RailPageSearch'

/** Why after a frame: the pressed control (pill ×, Clear, Delete) unmounts on commit and drops focus to body. */
function focusIfDropped(target: React.RefObject<HTMLButtonElement | null>): void {
  requestAnimationFrame(() => {
    const active = document.activeElement
    if (!active || active === document.body) {
      target.current?.focus({ preventScroll: true })
    }
  })
}

export function ArtifactCollection({
  artifacts,
  deletingSlugs,
  selectedSlug,
  selectArtifact,
  deleteArtifacts,
  clearSelectionRef,
  hasMore,
  loadingMore,
  loadMore,
  notice
}: {
  artifacts: readonly ArtifactListItem[]
  deletingSlugs: ReadonlySet<string>
  selectedSlug: string | null
  selectArtifact: (slug: string) => void
  deleteArtifacts: (items: readonly ArtifactListItem[]) => Promise<void>
  /** The page's Esc handler clears checked rows through this before it would close the page. */
  clearSelectionRef: React.RefObject<(() => boolean) | null>
  hasMore: boolean
  loadingMore: boolean
  loadMore: () => void
  /** The page's notice band (load error), drawn under the toolbar. */
  notice?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const [query, setQuery] = useState('')
  // Why: date filters read the clock once per filter change, not per render or keystroke.
  const [{ filter, nowMs }, setFilterState] = useState<{
    filter: ArtifactListFilter
    nowMs: number
  }>(() => ({ filter: EMPTY_ARTIFACT_LIST_FILTER, nowMs: Date.now() }))
  const setFilter = (next: ArtifactListFilter): void =>
    setFilterState({ filter: next, nowMs: Date.now() })
  const [sort, setSort] = useState<ArtifactListSort>(DEFAULT_ARTIFACT_LIST_SORT)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const filterButtonRef = useRef<HTMLButtonElement>(null)
  const restoreFocusToFilter = (): void => focusIfDropped(filterButtonRef)
  // Clamp before state/filtering so multi-MB pastes cannot reach either.
  const onQueryChange = (next: string): void => setQuery(clampArtifactListSearchQuery(next))
  const typeOptions = useMemo(() => artifactTypeOptions(artifacts, t), [artifacts, t])
  // Why: sort first, since filtering keeps order; a search keystroke is then one linear pass over the
  // already-loaded, already-sorted list, and only a sort or list change re-sorts. No IPC either way.
  const sorted = useMemo(
    () => sortArtifactList(artifacts, sort, intlLocale, t),
    [artifacts, sort, intlLocale, t]
  )
  const searched = useMemo(() => filterArtifactsBySearchQuery(sorted, query), [sorted, query])
  const matches = useMemo(
    () => filterArtifactList(searched, filter, nowMs),
    [searched, filter, nowMs]
  )
  const visibleSlugs = useMemo(() => matches.map(({ artifact }) => artifact.slug), [matches])
  const selection = useArtifactListSelection(visibleSlugs)
  const checkedItems = useMemo(
    () => matches.filter(({ artifact }) => selection.checkedSlugs.has(artifact.slug)),
    [matches, selection.checkedSlugs]
  )
  const narrowed = query.trim() !== '' || countArtifactListFilters(filter) > 0
  // Why: state, not a ref — the windowed rows need the scroller on their own mount pass.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)

  const { clear: clearSelection } = selection
  const selecting = selection.checkedSlugs.size > 0
  useEffect(() => {
    clearSelectionRef.current = selecting
      ? () => {
          clearSelection()
          focusIfDropped(filterButtonRef)
          return true
        }
      : null
    return () => {
      clearSelectionRef.current = null
    }
  }, [clearSelection, clearSelectionRef, selecting])

  return (
    <>
      <RailPageToolbar
        start={
          <div className="flex min-w-0 items-center gap-3">
            <ArtifactListFilterMenu
              triggerRef={filterButtonRef}
              filter={filter}
              typeOptions={typeOptions}
              onChange={setFilter}
            />
            {selecting ? (
              <ArtifactListSelectionBar
                count={checkedItems.length}
                deleteDisabled={checkedItems.every(({ artifact }) =>
                  deletingSlugs.has(artifact.slug)
                )}
                onDelete={() => void deleteArtifacts(checkedItems).then(restoreFocusToFilter)}
                onClear={() => {
                  selection.clear()
                  restoreFocusToFilter()
                }}
              />
            ) : null}
          </div>
        }
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
      {/* Mounted before any row is checked so the first count is announced, not just inserted. */}
      <span className="sr-only" aria-live="polite">
        {selecting
          ? t('auto.components.artifacts.ArtifactListSelectionBar.selected', '{{count}} selected', {
              count: checkedItems.length,
              defaultValue_one: '{{count}} selected'
            })
          : ''}
      </span>
      {notice}
      {countArtifactListFilters(filter) > 0 ? (
        <RailPageNotice>
          <ArtifactListFilterPills
            filter={filter}
            typeOptions={typeOptions}
            onChange={(next) => {
              setFilter(next)
              restoreFocusToFilter()
            }}
          />
        </RailPageNotice>
      ) : null}
      <RailPageBody>
        {/* Not padded: rows pad from the page gutter so hairlines and sticky cells share the page edges. */}
        <RailPageScroll
          ref={setScrollElement}
          className="group/artifact-table scrollbar-sleek min-h-0 flex-1 overflow-auto"
        >
          <ArtifactListTableHeader
            sort={sort}
            onSort={(field) => setSort(nextArtifactListSort(sort, field))}
            selectAllState={selection.headerState}
            canSelectAll={matches.length > 0}
            selecting={selecting}
            onToggleAll={selection.toggleAllVisible}
          />
          {/* Avoid w-fit row bands: they extend hover/selection washes to scroll width beyond the viewport. */}
          {matches.length > 0 ? (
            <ArtifactListRows
              artifacts={matches}
              deletingSlugs={deletingSlugs}
              selectedSlug={selectedSlug}
              checkedSlugs={selection.checkedSlugs}
              scrollElement={scrollElement}
              hasMore={hasMore}
              selectArtifact={selectArtifact}
              toggleChecked={selection.toggle}
              deleteArtifact={(item) => void deleteArtifacts([item]).then(restoreFocusToFilter)}
            />
          ) : (
            <div className="flex flex-col items-center gap-1 px-3 py-6 text-sm text-muted-foreground">
              <p>
                {t(
                  'auto.components.artifacts.ArtifactCollection.noMatchingArtifacts',
                  'No matching artifacts'
                )}
              </p>
              {narrowed ? (
                <Button
                  type="button"
                  variant="link-muted"
                  size="inlineText"
                  onClick={() => {
                    setFilter(EMPTY_ARTIFACT_LIST_FILTER)
                    onQueryChange('')
                    restoreFocusToFilter()
                  }}
                >
                  {t(
                    'auto.components.artifacts.ArtifactListFilterMenu.clearFilters',
                    'Clear filters'
                  )}
                </Button>
              ) : null}
            </div>
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
