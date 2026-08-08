import { Files, Loader2 } from 'lucide-react'
import type { ArtifactListItem } from '../../../../shared/artifacts'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { ArtifactActions } from './ArtifactActions'
import { ArtifactPreview } from './ArtifactPreview'

function formatArtifactDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value)
  )
}

function formatByteSize(value: number): string {
  if (value < 1024) {
    return `${value} B`
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function artifactName(item: ArtifactListItem): string {
  return item.artifact.title || item.artifact.originalFileName || item.artifact.slug
}

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
    <div className="grid min-h-0 flex-1 grid-cols-[16rem_minmax(0,1fr)] overflow-hidden rounded-md border border-border/50 bg-muted/20">
      <aside className="min-h-0 overflow-y-auto border-r border-border/50 scrollbar-sleek">
        {artifacts.map((item) => {
          const selected = item.artifact.slug === selectedArtifact.artifact.slug
          return (
            <button
              type="button"
              key={item.artifact.slug}
              data-current={selected ? 'true' : undefined}
              onClick={() => selectArtifact(item.artifact.slug)}
              className={cn(
                'flex w-full items-center gap-3 border-b border-border/50 px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-accent/50',
                selected && 'bg-accent'
              )}
            >
              <Files className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{artifactName(item)}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {formatArtifactDate(item.artifact.updatedAt)} ·{' '}
                  {formatByteSize(item.artifact.byteSize)}
                </span>
              </span>
            </button>
          )
        })}
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
      </aside>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">{artifactName(selectedArtifact)}</h2>
            <p className="truncate text-xs text-muted-foreground">
              {formatArtifactDate(selectedArtifact.artifact.updatedAt)} ·{' '}
              {formatByteSize(selectedArtifact.artifact.byteSize)}
            </p>
          </div>
          <ArtifactActions
            deleting={deletingId === selectedArtifact.artifact.slug}
            item={selectedArtifact}
            onDelete={deleteArtifact}
          />
        </div>
        <ArtifactPreview shareUrl={selectedArtifact.shareUrl} />
      </section>
    </div>
  )
}
