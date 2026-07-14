import { useEffect, useState } from 'react'
import { Database, ListX, PanelRightClose, Pin, PinOff, X } from 'lucide-react'
import { useSortable } from '@dnd-kit/sortable'
import type { Tab } from '../../../../shared/types'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { TabDragItemData } from '../tab-group/useTabDragSplit'
import {
  ACTIVE_TAB_INDICATOR_CLASSES,
  getDropIndicatorClasses,
  getTabRootStateClasses,
  getTabStripBorderClasses,
  type DropIndicator
} from './drop-indicator'
import { preventMiddleButtonDefault } from './middle-button-default-guard'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from './SortableTab'
import { TAB_CONTAINER_WIDTH_CLASSES, TAB_LABEL_WIDTH_CLASSES } from './tab-width-rules'
import { TabWorkspaceLayoutMenuSection } from './TabWorkspaceLayoutMenuSection'
import { useTabStripPointerActivation } from './tab-strip-pointer-activation'
import { translate } from '@/i18n/i18n'

export default function DatabaseTab({
  tab,
  isActive,
  isPinned,
  hasOtherTabs,
  hasTabsToRight,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onTogglePin,
  dragData,
  dropIndicator,
  includeTopTabBorder = true
}: {
  tab: Tab
  isActive: boolean
  isPinned: boolean
  hasOtherTabs: boolean
  hasTabsToRight: boolean
  onActivate: () => void
  onClose: () => void
  onCloseOthers: () => void
  onCloseToRight: () => void
  onTogglePin: () => void
  dragData: TabDragItemData
  dropIndicator?: DropIndicator
  includeTopTabBorder?: boolean
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef } = useSortable({ id: tab.id, data: dragData })
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })
  const label =
    tab.customLabel?.trim() ||
    tab.label ||
    translate('auto.components.database.tab.title', 'Database Query')
  const { onPointerDown } = useTabStripPointerActivation({ onActivate })

  useEffect(() => {
    const closeMenu = (): void => setMenuOpen(false)
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
  }, [])

  const tabRoot = (
    <div
      ref={setNodeRef}
      data-tab-id={tab.id}
      data-pinned={isPinned ? 'true' : 'false'}
      {...attributes}
      {...listeners}
      className={`group relative flex h-full cursor-pointer items-center px-1.5 text-xs select-none outline-none ${getTabStripBorderClasses(hasTabsToRight, { includeTopBorder: includeTopTabBorder })} ${getDropIndicatorClasses(dropIndicator ?? null)} ${getTabRootStateClasses(isActive)}`}
      onPointerDown={(event) => {
        onPointerDown(
          event,
          listeners?.onPointerDown as ((event: React.PointerEvent<Element>) => void) | undefined
        )
      }}
      onMouseDown={(event) => {
        if (event.button === 1) {
          event.preventDefault()
        }
      }}
      onMouseUp={preventMiddleButtonDefault}
      onAuxClick={(event) => {
        if (event.button !== 1) {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        if (!isPinned) {
          onClose()
        }
      }}
    >
      {isActive ? <span className={ACTIVE_TAB_INDICATOR_CLASSES} aria-hidden /> : null}
      <Database className="mr-1 size-3 shrink-0 text-muted-foreground" />
      {isPinned ? <Pin className="mr-1 size-3 shrink-0 text-muted-foreground" /> : null}
      <span className={`${TAB_LABEL_WIDTH_CLASSES} mr-1`}>{label}</span>
      {!isPinned ? (
        <button
          type="button"
          aria-label={translate('auto.components.database.tab.closeLabel', 'Close database tab')}
          className={`flex size-4 shrink-0 items-center justify-center rounded-sm ${
            isActive
              ? 'text-muted-foreground hover:bg-muted hover:text-foreground'
              : 'text-transparent group-hover:text-muted-foreground hover:!bg-muted hover:!text-foreground'
          }`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            onClose()
          }}
        >
          <X className="size-3" />
        </button>
      ) : null}
    </div>
  )

  return (
    <>
      <div
        className={TAB_CONTAINER_WIDTH_CLASSES}
        onContextMenuCapture={(event) => {
          event.preventDefault()
          window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
          setMenuPoint({ x: event.clientX, y: event.clientY })
          setMenuOpen(true)
        }}
      >
        {menuOpen ? (
          tabRoot
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>{tabRoot}</TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {label}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none fixed size-px opacity-0"
            style={{ left: menuPoint.x, top: menuPoint.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent sideOffset={0} align="start">
          <TabWorkspaceLayoutMenuSection
            unifiedTabId={dragData.unifiedTabId}
            groupId={dragData.groupId}
            trailingSeparator
          />
          <DropdownMenuItem onSelect={onTogglePin}>
            {isPinned ? <PinOff /> : <Pin />}
            {isPinned
              ? translate('auto.components.database.tab.unpin', 'Unpin Tab')
              : translate('auto.components.database.tab.pin', 'Pin Tab')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => !isPinned && onClose()} disabled={isPinned}>
            <X />
            {translate('auto.components.database.tab.close', 'Close')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onCloseOthers} disabled={!hasOtherTabs}>
            <ListX />
            {translate('auto.components.tab.bar.SortableTabContextMenu.8d16f9cd30', 'Close Others')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onCloseToRight} disabled={!hasTabsToRight}>
            <PanelRightClose />
            {translate('auto.components.database.tab.closeRight', 'Close Tabs To The Right')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
