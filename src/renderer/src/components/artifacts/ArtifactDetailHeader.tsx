import type { ReactNode } from 'react'
import { Globe, X } from 'lucide-react'
import type { ArtifactListItem } from '../../../../shared/artifacts'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { ArtifactActions } from './ArtifactActions'
import {
  formatArtifactExpiry,
  formatArtifactUpdatedAt,
  formatByteSize
} from './artifact-display-labels'

export function ArtifactDetailHeader({
  deleting,
  item,
  title,
  onClose,
  onDelete
}: {
  deleting: boolean
  item: ArtifactListItem
  title: ReactNode
  onClose: () => void
  onDelete: (target: ArtifactListItem) => void
}): React.JSX.Element {
  return (
    // Why: the drawer is right-anchored under the fixed Windows/Linux window-controls
    // overlay, which paints above it — inset the actions so they stay clickable.
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/50 px-4 py-3 pr-[max(1rem,var(--window-controls-width,0px))]">
      {/* Why: a floor rather than min-w-0 — otherwise the title truncates to nothing before the actions wrap. */}
      <div className="min-w-40 flex-1 space-y-0.5">
        {title}
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
      <div className="flex shrink-0 items-center gap-2">
        <ArtifactActions deleting={deleting} item={item} onDelete={onDelete} />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label={translate('auto.components.artifacts.ArtifactDetailHeader.close', 'Close')}
        >
          <X />
        </Button>
      </div>
    </div>
  )
}
