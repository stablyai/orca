import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Columns2,
  Pencil,
  Ungroup,
  X
} from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { TAB_CLUSTER_COLORS, type TabCluster } from '../../../../shared/tab-types'
import { getTabClusterSplitBlocker } from '../tab-group/tab-cluster-split-availability'
import { TAB_CONTEXT_MENU_CONTENT_CLASS } from './tab-context-menu-sizing'
import { TAB_CLUSTER_COLOR_CLASSES, TAB_CLUSTER_COLOR_LABELS } from './tab-cluster-colors'
import { useTabClusterMenuCloseAction } from './use-tab-cluster-menu-close-action'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/lib/close-all-context-menus'

export function TabClusterContextMenu({
  cluster,
  groupId,
  worktreeId,
  open,
  children,
  onOpenChange,
  onRename,
  onClose
}: {
  cluster: TabCluster
  groupId: string
  worktreeId: string
  open: boolean
  children: React.ReactNode
  onOpenChange: (open: boolean) => void
  onRename: () => void
  onClose: () => void
}): React.JSX.Element {
  const splitBlocker = useAppStore((state) => getTabClusterSplitBlocker(state, worktreeId))
  const setColor = useAppStore((state) => state.setTabClusterColor)
  const setCollapsed = useAppStore((state) => state.setTabClusterCollapsed)
  const ungroup = useAppStore((state) => state.ungroupTabCluster)
  const moveCluster = useAppStore((state) => state.moveTabCluster)
  const clusterMenuAction = useTabClusterMenuCloseAction()
  return (
    <ContextMenu
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
        }
        onOpenChange(nextOpen)
      }}
    >
      <ContextMenuTrigger asChild onContextMenu={(event) => event.stopPropagation()}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        className={TAB_CONTEXT_MENU_CONTENT_CLASS}
        onCloseAutoFocus={clusterMenuAction.runAfterClose}
      >
        <ContextMenuItem onSelect={() => clusterMenuAction.queueAfterClose(onRename)}>
          <Pencil className="size-3.5" />
          {translate('components.tabCluster.rename', 'Rename Group')}
        </ContextMenuItem>
        <ContextMenuLabel>
          {translate('components.tabCluster.color', 'Group Color')}
        </ContextMenuLabel>
        <div className="flex flex-wrap gap-1 px-2 pb-1">
          {TAB_CLUSTER_COLORS.map((color) => (
            <ContextMenuItem
              key={color}
              className="size-8 justify-center"
              role="menuitemradio"
              aria-checked={cluster.color === color}
              aria-label={translate(
                `components.tabCluster.colors.${color}`,
                TAB_CLUSTER_COLOR_LABELS[color]
              )}
              onSelect={() => setColor(groupId, cluster.id, color)}
            >
              <span
                aria-hidden
                className={cn(
                  'size-3.5 rounded-full',
                  TAB_CLUSTER_COLOR_CLASSES[color],
                  cluster.color === color &&
                    'ring-1 ring-foreground ring-offset-2 ring-offset-popover'
                )}
              />
            </ContextMenuItem>
          ))}
        </div>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => setCollapsed(groupId, cluster.id, !cluster.collapsed)}>
          {cluster.collapsed ? (
            <ChevronRight className="size-3.5" />
          ) : (
            <ChevronDown className="size-3.5" />
          )}
          {cluster.collapsed
            ? translate('components.tabCluster.expand', 'Expand Group')
            : translate('components.tabCluster.collapse', 'Collapse Group')}
        </ContextMenuItem>
        {splitBlocker ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <ContextMenuItem
                aria-disabled
                data-tab-cluster-split-unavailable={splitBlocker}
                onSelect={(event) => event.preventDefault()}
              >
                <Columns2 className="size-3.5" />
                {translate('components.tabCluster.moveToSplit', 'Move Group to New Split')}
              </ContextMenuItem>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8} className="z-[80] max-w-64">
              {translate(
                'components.tabCluster.moveToSplitUnavailableRemote',
                'Not available for workspaces on a remote Orca server. Drag the group into an existing split instead.'
              )}
            </TooltipContent>
          </Tooltip>
        ) : (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Columns2 className="size-3.5" />
              {translate('components.tabCluster.moveToSplit', 'Move Group to New Split')}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="max-w-[calc(100vw-1rem)] whitespace-nowrap">
              <ContextMenuItem
                onSelect={() =>
                  moveCluster(groupId, cluster.id, { groupId, splitDirection: 'right' })
                }
              >
                <ArrowRight className="size-3.5" />
                {translate('components.tabCluster.splitRight', 'Right')}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() =>
                  moveCluster(groupId, cluster.id, { groupId, splitDirection: 'left' })
                }
              >
                <ArrowLeft className="size-3.5" />
                {translate('components.tabCluster.splitLeft', 'Left')}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() =>
                  moveCluster(groupId, cluster.id, { groupId, splitDirection: 'down' })
                }
              >
                <ArrowDown className="size-3.5" />
                {translate('components.tabCluster.splitDown', 'Down')}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => moveCluster(groupId, cluster.id, { groupId, splitDirection: 'up' })}
              >
                <ArrowUp className="size-3.5" />
                {translate('components.tabCluster.splitUp', 'Up')}
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => ungroup(groupId, cluster.id)}>
          <Ungroup className="size-3.5" />
          {translate('components.tabCluster.ungroup', 'Ungroup')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onClose}>
          <X className="size-3.5" />
          {translate('components.tabCluster.close', 'Close Group')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
