// The card's ⋯: everything that isn't the one footer action, by how often it's used; the
// destructive ones last, after a separator.
import React from 'react'
import { Archive, ChevronDown, Monitor, MoreHorizontal, RotateCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { ArchiveSnapshotTooltip } from './ArchiveSnapshotTooltip'

export type CloudCardMenuItems = {
  details: { open: boolean; toggle: () => void }
  restart?: () => void
  moveToComputer?: () => void
  archive?: () => void
  delete?: () => void
}

export function CloudWorkspaceCardMenu({
  items,
  disabled,
  onOpenChange
}: {
  items: CloudCardMenuItems
  /** A restart, archive or unarchive is in flight. */
  disabled: boolean
  /** The card stays open while the menu is (its content renders outside the card). */
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const destructive = items.archive || items.delete
  return (
    <DropdownMenu modal={false} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={t('orcaCloudWorkspace.card.more', 'More actions')}
          data-cloud-card-more
        >
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom" className="min-w-44">
        <DropdownMenuItem onSelect={items.details.toggle}>
          <ChevronDown className={items.details.open ? 'rotate-180' : undefined} />
          {items.details.open
            ? t('orcaCloudWorkspace.card.hideDetails', 'Hide details')
            : t('orcaCloudWorkspace.card.details', 'Details')}
        </DropdownMenuItem>
        {items.restart ? (
          <DropdownMenuItem disabled={disabled} onSelect={items.restart}>
            <RotateCw />
            {t('orcaCloudWorkspace.restart', 'Restart')}
          </DropdownMenuItem>
        ) : null}
        {items.moveToComputer ? (
          <DropdownMenuItem disabled={disabled} onSelect={items.moveToComputer}>
            <Monitor />
            {t('orcaCloudWorkspace.moveToComputer', 'Move to this computer')}
          </DropdownMenuItem>
        ) : null}
        {destructive ? <DropdownMenuSeparator /> : null}
        {items.archive ? (
          // The shared "snapshot" definition, as on every other Archive control.
          <ArchiveSnapshotTooltip side="left">
            <DropdownMenuItem disabled={disabled} onSelect={items.archive}>
              <Archive />
              {t('orcaCloudWorkspace.archive', 'Archive')}
            </DropdownMenuItem>
          </ArchiveSnapshotTooltip>
        ) : null}
        {items.delete ? (
          <DropdownMenuItem variant="destructive" disabled={disabled} onSelect={items.delete}>
            <Trash2 />
            {t('orcaCloudWorkspace.card.delete', 'Delete')}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
