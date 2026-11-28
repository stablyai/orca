import { VirtualizedList } from '@/components/ui/virtualized-list'
import type { ArtifactListItem } from '../../../../shared/artifacts/artifacts'
import { ArtifactListRow } from './ArtifactListRow'
import { ARTIFACTS_TABLE_ROW_HEIGHT_PX } from './artifacts-table-layout'

/** Window the append-only artifact list inside the collection scroller; below the threshold, keep natural flow. */
export function ArtifactListRows({
  artifacts,
  deletingSlugs,
  selectedSlug,
  checkedSlugs,
  scrollElement,
  hasMore,
  selectArtifact,
  toggleChecked,
  deleteArtifact
}: {
  artifacts: readonly ArtifactListItem[]
  deletingSlugs: ReadonlySet<string>
  selectedSlug: string | null
  checkedSlugs: ReadonlySet<string>
  scrollElement: HTMLDivElement | null
  // Propagate the cursor so rows do not announce loaded count as the total while Load more still exists.
  hasMore: boolean
  selectArtifact: (slug: string) => void
  toggleChecked: (slug: string, range: boolean) => void
  deleteArtifact: (item: ArtifactListItem) => void
}): React.JSX.Element {
  // Pages are slug-deduped and renderRow has no index, so identify the last row by its unique slug.
  const lastSlug = artifacts.at(-1)?.artifact.slug

  // Transform-positioned inserts do not cause layout shifts that scroll anchoring could correct.
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
          deleting={deletingSlugs.has(item.artifact.slug)}
          isSelected={selectedSlug === item.artifact.slug}
          checked={checkedSlugs.has(item.artifact.slug)}
          selecting={checkedSlugs.size > 0}
          showDivider={item.artifact.slug !== lastSlug}
          selectArtifact={selectArtifact}
          toggleChecked={toggleChecked}
          deleteArtifact={deleteArtifact}
        />
      )}
    />
  )
}
