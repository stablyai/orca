import { Fragment } from 'react'
import { Copy, ExternalLink, MoreHorizontal, Trash2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ArtifactListItem } from '../../../../shared/artifacts'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { isPortaledRowMenuClick, isRowActivationKey } from '@/lib/list-row-interaction'
import {
  artifactName,
  artifactTypeLabel,
  formatArtifactExpiryCompact,
  formatArtifactUpdatedCompact,
  formatByteSize
} from './artifact-display-labels'
import { copyArtifactLink, openArtifactInBrowser } from './artifact-link-actions'
import { ARTIFACTS_TABLE_GRID_CLASS } from './artifacts-table-layout'
import { LIST_TABLE_ROW_CLASS, LIST_TABLE_ROW_SELECTED_CLASS } from '@/lib/list-table-layout'

type ArtifactRowAction = {
  key: string
  label: string
  icon: LucideIcon
  onSelect: () => void
  /** Rendered after a separator, styled as destructive. */
  destructive?: boolean
  disabled?: boolean
}

// Why: the row dropdown and the row context menu must offer the same actions; one source keeps them from drifting.
function artifactRowActions(
  item: ArtifactListItem,
  deleting: boolean,
  deleteArtifact: (item: ArtifactListItem) => void
): readonly ArtifactRowAction[] {
  return [
    {
      key: 'copy',
      label: translate('auto.components.artifacts.copyLink', 'Copy link'),
      icon: Copy,
      onSelect: () => void copyArtifactLink(item.shareUrl)
    },
    {
      key: 'open',
      label: translate('auto.components.artifacts.openInBrowser', 'Open in browser'),
      icon: ExternalLink,
      onSelect: () => openArtifactInBrowser(item.shareUrl)
    },
    {
      key: 'delete',
      label: translate('auto.components.artifacts.ArtifactsPage.deleteArtifact', 'Delete artifact'),
      icon: Trash2,
      onSelect: () => deleteArtifact(item),
      destructive: true,
      disabled: deleting
    }
  ]
}

export function ArtifactListRows({
  artifacts,
  deletingId,
  selectedSlug,
  selectArtifact,
  deleteArtifact
}: {
  artifacts: readonly ArtifactListItem[]
  deletingId: string | null
  selectedSlug: string | null
  selectArtifact: (slug: string) => void
  deleteArtifact: (item: ArtifactListItem) => void
}): React.JSX.Element {
  return (
    <>
      {artifacts.map((item) => {
        const name = artifactName(item)
        const typeLabel = artifactTypeLabel(item)
        const updatedLabel = formatArtifactUpdatedCompact(item.artifact.updatedAt)
        const expiryLabel = formatArtifactExpiryCompact(item.artifact.expiresAt)
        const sizeLabel = formatByteSize(item.artifact.byteSize)
        const isSelected = selectedSlug === item.artifact.slug
        const deleting = deletingId === item.artifact.slug
        const rowActions = artifactRowActions(item, deleting, deleteArtifact)

        return (
          <ContextMenu key={item.artifact.slug}>
            <ContextMenuTrigger asChild>
              <div
                role="button"
                tabIndex={0}
                data-current={isSelected ? 'true' : undefined}
                onClick={(event) => {
                  if (isPortaledRowMenuClick(event)) {
                    return
                  }
                  selectArtifact(item.artifact.slug)
                }}
                onKeyDown={(event) => {
                  if (!isRowActivationKey(event)) {
                    return
                  }
                  event.preventDefault()
                  selectArtifact(item.artifact.slug)
                }}
                className={cn(
                  ARTIFACTS_TABLE_GRID_CLASS,
                  LIST_TABLE_ROW_CLASS,
                  isSelected && LIST_TABLE_ROW_SELECTED_CLASS
                )}
              >
                <span className="min-w-0 truncate font-medium" title={name}>
                  {name}
                </span>
                <span className="min-w-0 truncate text-muted-foreground" title={typeLabel}>
                  {typeLabel}
                </span>
                <span className="min-w-0 truncate text-muted-foreground" title={sizeLabel}>
                  {sizeLabel}
                </span>
                <span className="min-w-0 truncate text-muted-foreground" title={updatedLabel}>
                  {updatedLabel}
                </span>
                <span className="min-w-0 truncate text-muted-foreground" title={expiryLabel}>
                  {expiryLabel}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="size-7 text-muted-foreground"
                      aria-label={translate(
                        'auto.components.artifacts.actions',
                        'Artifact actions'
                      )}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    {rowActions.map(
                      ({ key, label, icon: Icon, onSelect, destructive, disabled }) => (
                        <Fragment key={key}>
                          {destructive ? <DropdownMenuSeparator /> : null}
                          <DropdownMenuItem
                            variant={destructive ? 'destructive' : 'default'}
                            disabled={disabled}
                            onSelect={onSelect}
                          >
                            <Icon className="size-3.5" />
                            {label}
                          </DropdownMenuItem>
                        </Fragment>
                      )
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-48">
              {rowActions.map(({ key, label, icon: Icon, onSelect, destructive, disabled }) => (
                <Fragment key={key}>
                  {destructive ? <ContextMenuSeparator /> : null}
                  <ContextMenuItem
                    variant={destructive ? 'destructive' : 'default'}
                    disabled={disabled}
                    onSelect={onSelect}
                  >
                    <Icon className="size-3.5" />
                    {label}
                  </ContextMenuItem>
                </Fragment>
              ))}
            </ContextMenuContent>
          </ContextMenu>
        )
      })}
    </>
  )
}
