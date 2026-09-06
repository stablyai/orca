import React from 'react'
import { ChevronDown, Ellipsis } from 'lucide-react'
import type { VirtualItem } from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { translate } from '@/i18n/i18n'
import type { Collection } from '../../../../../../shared/collection-types'
import type { GroupHeaderRow } from '../grouping/row-types'
import { getVirtualRowTransform } from '../viewport/virtual-rows'
import { ProjectHeaderActions } from '../../ProjectHeaderActions'
import { REPO_HEADER_ACTION_BUTTON_CLASS } from '../../repo-header-action-button-class'
import {
  getProjectGroupHeaderPaddingLeft,
  WORKTREE_SECTION_HEADER_PADDING_LEFT
} from './indentation'
import {
  handleRepoHeaderActionPointerDown,
  stopRepoHeaderKeyboardToggle,
  stopRepoHeaderMenuEvent
} from './header-event-guards'
import { getWorktreeOptionId } from './option-dom'

export type CollectionSectionHeaderContext = {
  collapsedGroups: Set<string>
  toggleGroupWithScrollAnchor: (groupKey: string) => void
  onRenameCollection: (collectionId: string, currentName: string) => void
  onDeleteCollection: (collectionId: string, name: string) => void
  onAddWorktreesToCollection: (collection: Collection) => void
}

export function renderCollectionSectionHeaderRow(args: {
  ctx: CollectionSectionHeaderContext
  row: GroupHeaderRow
  vItem: VirtualItem
  hasHeaderTopSpacing: boolean
  measureVirtualRowElement: (element: HTMLDivElement | null) => void
}): React.JSX.Element | null {
  const { ctx, row, vItem } = args
  const collection = row.collection
  if (!collection) {
    return null
  }
  const isCollectionRepoSubheader = row.repo !== undefined
  const isHeaderCollapsed = ctx.collapsedGroups.has(row.key)
  return (
    <div
      key={vItem.key}
      role="presentation"
      data-worktree-virtual-row
      data-worktree-virtual-row-key={String(vItem.key)}
      data-worktree-virtual-row-start={vItem.start}
      data-index={vItem.index}
      ref={args.measureVirtualRowElement}
      className={cn('absolute left-0 right-0 top-0', args.hasHeaderTopSpacing && 'pt-1')}
      style={{ transform: getVirtualRowTransform(vItem.start) }}
    >
      <div
        id={getWorktreeOptionId(row.key)}
        role="button"
        tabIndex={0}
        aria-expanded={!isHeaderCollapsed}
        data-collection-header-id={isCollectionRepoSubheader ? undefined : collection.id}
        data-collection-drop-id={collection.id}
        className="group relative flex h-7 w-full cursor-pointer items-center gap-1.5 pr-2 text-left transition-all"
        style={{
          paddingLeft: isCollectionRepoSubheader
            ? getProjectGroupHeaderPaddingLeft(1)
            : WORKTREE_SECTION_HEADER_PADDING_LEFT
        }}
        onClick={() => ctx.toggleGroupWithScrollAnchor(row.key)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            ctx.toggleGroupWithScrollAnchor(row.key)
          }
        }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch">
          {isCollectionRepoSubheader && row.repo ? (
            <div className="flex size-4 shrink-0 items-center justify-center rounded-[4px] text-muted-foreground">
              <RepoIconGlyph
                repoIcon={row.repo.repoIcon}
                color={row.repo.badgeColor}
                className="size-4"
                iconClassName="size-3.5"
              />
            </div>
          ) : row.icon ? (
            <div
              className={cn(
                'flex size-4 shrink-0 items-center justify-center rounded-[4px]',
                row.tone
              )}
              style={collection.color ? { color: collection.color } : undefined}
            >
              <row.icon className="size-3" />
            </div>
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <div className="min-w-0 truncate text-[13px] font-semibold leading-none">
                {row.label}
              </div>
              <span className="shrink-0 text-[11px] leading-none text-muted-foreground">
                {row.count}
              </span>
            </div>
          </div>
        </div>
        <ProjectHeaderActions>
          <div
            className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
            aria-hidden
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              ctx.toggleGroupWithScrollAnchor(row.key)
            }}
          >
            <ChevronDown
              className={cn('size-3.5 transition-transform', isHeaderCollapsed && '-rotate-90')}
            />
          </div>
          {!isCollectionRepoSubheader ? (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className={REPO_HEADER_ACTION_BUTTON_CLASS}
                  data-repo-header-action=""
                  aria-label={translate(
                    'auto.components.sidebar.WorktreeList.collectionActionsLabel',
                    'Collection actions for {{value0}}',
                    { value0: row.label }
                  )}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={stopRepoHeaderKeyboardToggle}
                  onPointerDown={handleRepoHeaderActionPointerDown}
                >
                  <Ellipsis className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                side="bottom"
                sideOffset={6}
                onPointerDown={stopRepoHeaderMenuEvent}
                onMouseDown={stopRepoHeaderMenuEvent}
                onPointerUp={stopRepoHeaderMenuEvent}
                onMouseUp={stopRepoHeaderMenuEvent}
                onClick={stopRepoHeaderMenuEvent}
                onKeyDown={stopRepoHeaderMenuEvent}
              >
                <DropdownMenuItem onSelect={() => ctx.onAddWorktreesToCollection(collection)}>
                  {translate(
                    'auto.components.sidebar.WorktreeList.collectionAddWorktreesItem',
                    'Add worktrees…'
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => ctx.onRenameCollection(collection.id, row.label)}>
                  {translate(
                    'auto.components.sidebar.WorktreeList.collectionRenameItem',
                    'Rename collection'
                  )}
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => ctx.onDeleteCollection(collection.id, row.label)}
                >
                  {translate(
                    'auto.components.sidebar.WorktreeList.collectionDeleteItem',
                    'Delete collection'
                  )}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </ProjectHeaderActions>
      </div>
    </div>
  )
}
