import { VirtualizedList } from '@/components/virtualized-list'
import type { ArtifactListItem } from '../../../../shared/artifacts'
import { ArtifactListRow } from './ArtifactListRow'
import { ARTIFACTS_TABLE_ROW_HEIGHT_PX } from './artifacts-table-layout'

/**
 * The artifacts table body, windowed inside the collection's scroller. Load more only appends, so
 * between refreshes the list grows without bound; below the virtualize threshold rows stay in
 * natural flow.
 */
export function ArtifactListRows({
  artifacts,
  deletingId,
  selectedSlug,
  scrollElement,
  hasMore,
  selectArtifact,
  deleteArtifact
}: {
  artifacts: readonly ArtifactListItem[]
  deletingId: string | null
  selectedSlug: string | null
  scrollElement: HTMLDivElement | null
  // Why it has to reach the rows: the cursor is what makes the loaded count not the real total, so
  // without it every row would announce a set size the Load more button next to it contradicts.
  hasMore: boolean
  selectArtifact: (slug: string) => void
  deleteArtifact: (item: ArtifactListItem) => void
}): React.JSX.Element {
  // Why: appended pages are deduped against the slugs already loaded, and the first page's are
  // unique per the server, so a slug identifies the last row without an index — which `renderRow`
  // does not supply.
  const lastSlug = artifacts.at(-1)?.artifact.slug

  // Accepted: rows are transform-positioned, so an insert above the viewport slides the list with
  // no layout shift for scroll anchoring to correct.
  return (
    <VirtualizedList
      rows={artifacts}
      scrollElement={scrollElement}
      estimateRowHeightPx={ARTIFACTS_TABLE_ROW_HEIGHT_PX}
      announceListPosition
      hasUnloadedRows={hasMore}
      getRowKey={(item) => item.artifact.slug}
      renderRow={(item) => (
        <ArtifactListRow
          key={item.artifact.slug}
          item={item}
          deleting={deletingId === item.artifact.slug}
          isSelected={selectedSlug === item.artifact.slug}
          showDivider={item.artifact.slug !== lastSlug}
          selectArtifact={selectArtifact}
          deleteArtifact={deleteArtifact}
        />
      )}
    />
  )
}
