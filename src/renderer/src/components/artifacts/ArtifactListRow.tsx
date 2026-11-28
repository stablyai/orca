import { Fragment, useState } from 'react'
import {
  Copy,
  ExternalLink,
  File,
  FileText,
  Image as ImageIcon,
  MoreHorizontal,
  Trash2
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ArtifactListItem } from '../../../../shared/artifacts/artifacts'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { isPortaledRowMenuClick } from '@/lib/list-interaction/list-row-interaction'
import { getSelectionIntent } from '@/lib/list-interaction/list-multi-selection'
import {
  artifactName,
  artifactTypeLabel,
  formatArtifactExpiryCompact,
  formatArtifactUpdatedCompact,
  formatByteSize
} from './artifact-display-labels'
import { copyArtifactLink, openArtifactInBrowser } from './artifact-link-actions'
import {
  ARTIFACTS_TABLE_GRID_CLASS,
  ARTIFACTS_TABLE_WIDE_ONLY_CLASS
} from './artifacts-table-layout'
import {
  LIST_TABLE_ROW_CLASS,
  LIST_TABLE_ROW_DIVIDER_CLASS,
  LIST_TABLE_ROW_SELECTED_CLASS
} from '@/lib/list-interaction/list-table-layout'

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
  deleteArtifact: (item: ArtifactListItem) => void,
  t: Translate = translate
): readonly ArtifactRowAction[] {
  return [
    {
      key: 'copy',
      label: t('auto.components.artifacts.copyLink', 'Copy link'),
      icon: Copy,
      onSelect: () => void copyArtifactLink(item.shareUrl)
    },
    {
      key: 'open',
      label: t('auto.components.artifacts.openInBrowser', 'Open in browser'),
      icon: ExternalLink,
      onSelect: () => openArtifactInBrowser(item.shareUrl)
    },
    {
      key: 'delete',
      label: t('auto.components.artifacts.ArtifactsPage.deleteArtifact', 'Delete artifact'),
      icon: Trash2,
      onSelect: () => deleteArtifact(item),
      destructive: true,
      disabled: deleting
    }
  ]
}

export function ArtifactListRow({
  item,
  deleting,
  isSelected,
  checked,
  selecting,
  showDivider,
  selectArtifact,
  toggleChecked,
  deleteArtifact
}: {
  item: ArtifactListItem
  deleting: boolean
  isSelected: boolean
  /** Checked for a bulk action; separate from `isSelected`, the row open in the drawer. */
  checked: boolean
  /** Any row is checked, so checkboxes replace type icons on every row. */
  selecting: boolean
  /** Omit only the final divider; the next Load more block or table border supplies that edge. */
  showDivider: boolean
  selectArtifact: (slug: string) => void
  toggleChecked: (slug: string, range: boolean) => void
  deleteArtifact: (item: ArtifactListItem) => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const name = artifactName(item)
  const typeLabel = artifactTypeLabel(item, t)
  const contentType = item.artifact.sourceContentType
  const TypeIcon =
    contentType === 'text/html' ? FileText : contentType.startsWith('image/') ? ImageIcon : File
  const updatedLabel = formatArtifactUpdatedCompact(item.artifact.updatedAt, t, intlLocale)
  const expiryLabel = formatArtifactExpiryCompact(item.artifact.expiresAt, t, intlLocale)
  const sizeLabel = formatByteSize(item.artifact.byteSize)
  const rowActions = artifactRowActions(item, deleting, deleteArtifact, t)
  // Why: the checkbox shows on hover, focus-within or while selecting; it joins the tab order only
  // while shown from the keyboard, so Shift+Tab from the focused name reaches it and Tab skips it otherwise.
  const [focusWithin, setFocusWithin] = useState(false)
  // Why scroll-mt-12 on each row control: they take focus, not the row, so the row's scroll-mt-8 never
  // applies. 12 clears the sticky h-8 header plus the row's top padding, so the focused control's row stays in view.

  return (
    // Non-modal, so scrolling is never blocked: windowing unmounting an open menu mid-scroll reads as dismissal.
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* Not itself a button: the checkbox, the name and the actions menu are sibling controls,
            so none is nested in another; a click anywhere on the row still opens it. */}
        <div
          data-current={isSelected ? 'true' : undefined}
          // React bubbles focus out of the portaled row menus too; only the row's own DOM counts.
          onFocus={(event) => {
            if (event.currentTarget.contains(event.target)) {
              setFocusWithin(true)
            }
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.target)) {
              return
            }
            const next = event.relatedTarget
            if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
              setFocusWithin(false)
            }
          }}
          onMouseDown={(event) => {
            // Shift-click extends the check range; keep it from also selecting row text.
            if (event.shiftKey) {
              event.preventDefault()
            }
          }}
          onClick={(event) => {
            if (isPortaledRowMenuClick(event)) {
              return
            }
            const intent = getSelectionIntent(event, navigator.userAgent.includes('Mac'))
            if (intent !== 'replace') {
              toggleChecked(item.artifact.slug, intent === 'range')
              return
            }
            selectArtifact(item.artifact.slug)
          }}
          className={cn(
            ARTIFACTS_TABLE_GRID_CLASS,
            LIST_TABLE_ROW_CLASS,
            showDivider && LIST_TABLE_ROW_DIVIDER_CLASS,
            (isSelected || checked) && LIST_TABLE_ROW_SELECTED_CLASS
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            {/* The checkbox swaps in over the type icon, so checking never shifts the Name column. */}
            <span className="relative flex size-4 shrink-0 items-center justify-center">
              <TypeIcon
                aria-hidden="true"
                className={cn(
                  'size-4 text-muted-foreground',
                  selecting
                    ? 'invisible'
                    : 'group-hover/list-table-row:invisible group-focus-within/list-table-row:invisible'
                )}
              />
              <span
                className={cn(
                  'absolute inset-0 flex items-center justify-center',
                  // Hidden, it takes no pointer or touch hits, so a tap there opens the row instead.
                  !selecting &&
                    'pointer-events-none opacity-0 group-hover/list-table-row:pointer-events-auto group-hover/list-table-row:opacity-100 group-focus-within/list-table-row:pointer-events-auto group-focus-within/list-table-row:opacity-100'
                )}
              >
                <Checkbox
                  checked={checked}
                  tabIndex={selecting || focusWithin ? undefined : -1}
                  className="scroll-mt-12"
                  aria-label={t(
                    'auto.components.artifacts.ArtifactListRow.select',
                    'Select {{name}}',
                    {
                      name
                    }
                  )}
                  onClick={(event) => {
                    event.stopPropagation()
                    event.preventDefault()
                    toggleChecked(item.artifact.slug, event.shiftKey)
                  }}
                />
              </span>
            </span>
            {/* The keyboard path to open the row: Enter/Space click it and the click reaches the row. */}
            <button
              type="button"
              className="min-w-0 scroll-mt-12 truncate rounded-sm text-left font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              title={name}
            >
              {name}
            </button>
          </div>
          <span
            className={cn(
              'min-w-0 truncate text-muted-foreground',
              ARTIFACTS_TABLE_WIDE_ONLY_CLASS
            )}
            title={typeLabel}
          >
            {typeLabel}
          </span>
          <span
            className={cn(
              'min-w-0 truncate text-muted-foreground',
              ARTIFACTS_TABLE_WIDE_ONLY_CLASS
            )}
            title={sizeLabel}
          >
            {sizeLabel}
          </span>
          <span className="min-w-0 truncate text-muted-foreground" title={updatedLabel}>
            {updatedLabel}
          </span>
          <span
            className={cn(
              'min-w-0 truncate text-muted-foreground',
              ARTIFACTS_TABLE_WIDE_ONLY_CLASS
            )}
            title={expiryLabel}
          >
            {expiryLabel}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost-muted"
                size="icon-toolbar"
                className="scroll-mt-12 justify-self-end"
                aria-label={t('auto.components.artifacts.actions', 'Artifact actions')}
                onClick={(event) => event.stopPropagation()}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {rowActions.map(({ key, label, icon: Icon, onSelect, destructive, disabled }) => (
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
              ))}
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
}
