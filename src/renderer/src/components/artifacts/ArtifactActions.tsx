import { Copy, ExternalLink, Loader2, MoreHorizontal, Trash2 } from 'lucide-react'
import type { ArtifactListItem } from '../../../../shared/artifacts/artifacts'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { copyArtifactLink, openArtifactInBrowser } from './artifact-link-actions'

type ArtifactActionsProps = {
  deleting: boolean
  item: ArtifactListItem
  onDelete: (item: ArtifactListItem) => void
}

export function ArtifactActions({
  deleting,
  item,
  onDelete
}: ArtifactActionsProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      className="flex shrink-0 items-center gap-2"
      aria-label={t('auto.components.artifacts.actions', 'Artifact actions')}
    >
      <Button size="sm" onClick={() => void copyArtifactLink(item.shareUrl)}>
        <Copy />
        {t('auto.components.artifacts.copyLink', 'Copy link')}
      </Button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => openArtifactInBrowser(item.shareUrl)}
            aria-label={t('auto.components.artifacts.openInBrowser', 'Open in browser')}
          >
            <ExternalLink />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {t('auto.components.artifacts.openInBrowser', 'Open in browser')}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-foreground"
            disabled={deleting}
            aria-label={t(
              'auto.components.artifacts.ArtifactActions.more',
              'More artifact actions'
            )}
          >
            {deleting ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem
            variant="destructive"
            disabled={deleting}
            onSelect={() => onDelete(item)}
          >
            <Trash2 className="size-3.5" />
            {t('auto.components.artifacts.ArtifactsPage.deleteArtifact', 'Delete artifact')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
