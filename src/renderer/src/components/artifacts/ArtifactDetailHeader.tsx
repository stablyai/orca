import { Globe } from 'lucide-react'
import type { ArtifactListItem } from '../../../../shared/artifacts'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { ArtifactActions } from './ArtifactActions'
import {
  artifactName,
  formatArtifactExpiry,
  formatArtifactUpdatedAt,
  formatByteSize
} from './artifact-display-labels'

export function ArtifactDetailHeader({
  deleting,
  item,
  onDelete
}: {
  deleting: boolean
  item: ArtifactListItem
  onDelete: (target: ArtifactListItem) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/50 px-4 py-3">
      {/* Why: a floor rather than min-w-0 — otherwise the title truncates to nothing before the actions wrap. */}
      <div className="min-w-40 flex-1 space-y-0.5">
        <h2 className="truncate text-sm font-semibold">{artifactName(item)}</h2>
        <div className="flex min-w-0 items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Globe className="size-3 shrink-0 text-muted-foreground" />
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate(
                'auto.components.artifacts.ArtifactDetailHeader.publicLink',
                'Anyone with this link can view it'
              )}
            </TooltipContent>
          </Tooltip>
          <span className="sr-only">
            {translate(
              'auto.components.artifacts.ArtifactDetailHeader.publicLink',
              'Anyone with this link can view it'
            )}
          </span>
          <p className="truncate font-mono text-xs text-muted-foreground">{item.shareUrl}</p>
        </div>
        <p className="truncate text-[11px] text-muted-foreground">
          {formatArtifactUpdatedAt(item.artifact.updatedAt)} ·{' '}
          {formatByteSize(item.artifact.byteSize)} · {formatArtifactExpiry(item.artifact.expiresAt)}
        </p>
      </div>
      <ArtifactActions deleting={deleting} item={item} onDelete={onDelete} />
    </div>
  )
}
