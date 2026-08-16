import type { ArtifactListItem } from '../../../../shared/artifacts'
import { ArtifactDetailHeader } from './ArtifactDetailHeader'
import { ArtifactListPane } from './ArtifactListPane'
import { ArtifactPreview } from './ArtifactPreview'

export function ArtifactCollection({
  artifacts,
  deletingId,
  selectedArtifact,
  selectArtifact,
  deleteArtifact,
  hasMore,
  loadingMore,
  loadMore
}: {
  artifacts: readonly ArtifactListItem[]
  deletingId: string | null
  selectedArtifact: ArtifactListItem
  selectArtifact: (slug: string) => void
  deleteArtifact: (item: ArtifactListItem) => void
  hasMore: boolean
  loadingMore: boolean
  loadMore: () => void
}): React.JSX.Element {
  return (
    // Why: match Automations while stacking the list on narrow layouts.
    <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden lg:grid-cols-[minmax(240px,300px)_minmax(0,1fr)] lg:grid-rows-1">
      <ArtifactListPane
        className="max-h-56 border-b border-border/50 bg-muted/20 lg:max-h-none lg:border-b-0 lg:border-r"
        artifacts={artifacts}
        deletingId={deletingId}
        selectedArtifact={selectedArtifact}
        selectArtifact={selectArtifact}
        deleteArtifact={deleteArtifact}
        hasMore={hasMore}
        loadingMore={loadingMore}
        loadMore={loadMore}
      />
      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <ArtifactDetailHeader
          deleting={deletingId === selectedArtifact.artifact.slug}
          item={selectedArtifact}
          onDelete={deleteArtifact}
        />
        <ArtifactPreview shareUrl={selectedArtifact.shareUrl} />
      </section>
    </div>
  )
}
