import { useEffect, useRef, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TruncatedSidebarLabel } from '@/components/sidebar/truncated-sidebar-label'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { TabCluster } from '../../../../shared/tab-types'
import { getTabClusterSortableId, type TabClusterDragItemData } from '../tab-group/tab-drag-data'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from './SortableTab'
import { TabClusterContextMenu } from './TabClusterContextMenu'
import { TAB_CLUSTER_COLOR_CLASSES } from './tab-cluster-colors'
import { getDropIndicatorClasses, type DropIndicator } from './drop-indicator'
import { useTabStripPointerActivation } from './tab-strip-pointer-activation'
import { useTabStripRename } from './use-tab-strip-rename'
import { useTabClusterRenameRequest } from './tab-cluster-rename-request'

export function TabClusterChip({
  cluster,
  groupId,
  worktreeId,
  onClose,
  dropIndicator
}: {
  cluster: TabCluster
  groupId: string
  worktreeId: string
  onClose: () => void
  dropIndicator?: DropIndicator
}): React.JSX.Element {
  const renameCluster = useAppStore((state) => state.renameTabCluster)
  const setCollapsed = useAppStore((state) => state.setTabClusterCollapsed)
  const restoreCollapseState = useAppStore((state) => state.restoreTabClusterCollapseState)
  const rename = useTabStripRename({
    value: cluster.name,
    onCommit: (name) => renameCluster(groupId, cluster.id, name)
  })
  useTabClusterRenameRequest(worktreeId, groupId, cluster.id, rename.handleRenameOpen)
  const [menuOpen, setMenuOpen] = useState(false)
  const sortableId = getTabClusterSortableId(groupId, cluster.id)
  const dragData: TabClusterDragItemData = {
    kind: 'tab-cluster',
    worktreeId,
    groupId,
    clusterId: cluster.id,
    name: cluster.name,
    color: cluster.color,
    collapsed: cluster.collapsed
  }
  const { attributes, listeners, setNodeRef } = useSortable({ id: sortableId, data: dragData })
  const toggleCollapsed = (): void => setCollapsed(groupId, cluster.id, !cluster.collapsed)
  const clickCountRef = useRef(0)
  const collapseBeforeClickRef = useRef<Pick<TabCluster, 'collapsed' | 'shownTabId'> | null>(null)
  const { onPointerDown } = useTabStripPointerActivation({
    onActivate: () => {
      const clickCount = clickCountRef.current
      clickCountRef.current = 0
      // Why: Collapse updates can lose the browser's dblclick before React receives it.
      if (clickCount >= 2) {
        // Why: toggling back would recapture the active member instead of the original sticky one.
        if (collapseBeforeClickRef.current) {
          restoreCollapseState(groupId, cluster.id, collapseBeforeClickRef.current)
          collapseBeforeClickRef.current = null
        }
        rename.handleRenameOpen()
      } else {
        collapseBeforeClickRef.current = {
          collapsed: cluster.collapsed,
          shownTabId: cluster.shownTabId
        }
        toggleCollapsed()
      }
    },
    disabled: rename.isEditing
  })

  useEffect(() => {
    const close = (): void => setMenuOpen(false)
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, close)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, close)
  }, [])
  useEffect(() => {
    if (!menuOpen) {
      return
    }
    const close = (): void => setMenuOpen(false)
    window.addEventListener('blur', close)
    return () => window.removeEventListener('blur', close)
  }, [menuOpen])

  const chip = (
    <div
      ref={setNodeRef}
      {...attributes}
      {...(rename.isEditing ? undefined : listeners)}
      data-tab-cluster-chip={cluster.id}
      aria-label={cluster.name || translate('components.tabCluster.unnamed', 'Unnamed group')}
      aria-expanded={!cluster.collapsed}
      className={cn(
        'relative flex h-full shrink-0 cursor-pointer select-none items-center gap-1.5 px-2 text-xs text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
        getDropIndicatorClasses(dropIndicator ?? null)
      )}
      onPointerDown={(event) => {
        clickCountRef.current = 0
        onPointerDown(event, (dragEvent) => listeners?.onPointerDown?.(dragEvent))
      }}
      onMouseDown={(event) => {
        clickCountRef.current = event.detail
      }}
      onClick={(event) => {
        if (event.detail === 0 && !rename.isEditing) {
          toggleCollapsed()
        }
      }}
      onKeyDown={(event) => {
        if (rename.isEditing || (event.key !== 'Enter' && event.key !== ' ')) {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        toggleCollapsed()
      }}
      onDoubleClick={(event) => {
        event.stopPropagation()
        if (clickCountRef.current === 0 && !rename.isEditing) {
          rename.handleRenameOpen()
        }
      }}
    >
      <span
        aria-hidden
        className={cn('size-2.5 shrink-0 rounded-full', TAB_CLUSTER_COLOR_CLASSES[cluster.color])}
      />
      {rename.isEditing ? (
        <Input
          ref={rename.setRenameInputElement}
          data-tab-cluster-rename-input={cluster.id}
          aria-label={translate('components.tabCluster.rename', 'Rename Group')}
          value={rename.renameValue}
          onChange={(event) => rename.setRenameValue(event.target.value)}
          onBlur={rename.commitRename}
          onKeyDown={rename.onRenameKeyDown}
          onKeyUp={rename.onRenameKeyUp}
          onCompositionStart={rename.onRenameCompositionStart}
          onCompositionEnd={rename.onRenameCompositionEnd}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          className="h-6 w-28 min-w-20"
          spellCheck={false}
        />
      ) : cluster.name ? (
        <TruncatedSidebarLabel
          text={cluster.name}
          className="max-w-28"
          tooltipEnabled={!menuOpen}
          tooltipSide="bottom"
          tooltipSideOffset={6}
        />
      ) : null}
      {cluster.collapsed ? (
        <span className="shrink-0 tabular-nums text-muted-foreground">{cluster.tabIds.length}</span>
      ) : null}
    </div>
  )

  return (
    <TabClusterContextMenu
      cluster={cluster}
      groupId={groupId}
      worktreeId={worktreeId}
      open={menuOpen}
      onOpenChange={setMenuOpen}
      onRename={rename.handleRenameOpen}
      onClose={onClose}
    >
      <div data-tab-strip-slot={sortableId} className="flex h-full shrink-0">
        {!cluster.name && !rename.isEditing && !menuOpen ? (
          <Tooltip>
            <TooltipTrigger asChild>{chip}</TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('components.tabCluster.unnamed', 'Unnamed group')}
            </TooltipContent>
          </Tooltip>
        ) : (
          chip
        )}
      </div>
    </TabClusterContextMenu>
  )
}
