import { useEffect, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Globe, X, ExternalLink, Columns2, Rows2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ORCA_BROWSER_BLANK_URL } from '../../../../shared/constants'
import type { BrowserTab as BrowserTabState } from '../../../../shared/types'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from './SortableTab'
import { getLiveBrowserUrl } from '../browser-pane/browser-runtime'
import type { TabDragItemData } from '../tab-group/useTabDragSplit'

function formatBrowserTabUrlLabel(url: string): string {
  if (url === ORCA_BROWSER_BLANK_URL || url === 'about:blank') {
    return 'New Tab'
  }
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return url
  }
}

function getBrowserTabLabel(tab: BrowserTabState): string {
  if (
    !tab.title ||
    tab.title === tab.url ||
    tab.title === ORCA_BROWSER_BLANK_URL ||
    tab.title === 'about:blank'
  ) {
    return formatBrowserTabUrlLabel(tab.url)
  }
  return tab.title || tab.url
}

function isBlankBrowserTab(tab: BrowserTabState): boolean {
  return tab.url === ORCA_BROWSER_BLANK_URL || tab.url === 'about:blank'
}

export default function BrowserTab({
  tab,
  isActive,
  hasTabsToRight,
  onActivate,
  onClose,
  onCloseToRight,
  onSplitGroup,
  dragData
}: {
  tab: BrowserTabState
  isActive: boolean
  hasTabsToRight: boolean
  onActivate: () => void
  onClose: () => void
  onCloseToRight: () => void
  onSplitGroup: (direction: 'left' | 'right' | 'up' | 'down', sourceVisibleTabId: string) => void
  dragData: TabDragItemData
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
    data: dragData
  })
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })

  // Why: about:blank and other non-http URLs should not be sent to the
  // system browser. Disable the context menu item instead of silently
  // calling shell.openUrl with an unsupported URL.
  const openInBrowserUrl = getLiveBrowserUrl(tab.id) ?? tab.url
  let isHttpUrl = false
  try {
    const parsed = new URL(openInBrowserUrl)
    isHttpUrl = parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    // invalid URL — leave disabled
  }

  useEffect(() => {
    const closeMenu = (): void => setMenuOpen(false)
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
  }, [])

  return (
    <>
      <div
        onContextMenuCapture={(event) => {
          event.preventDefault()
          window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
          setMenuPoint({ x: event.clientX, y: event.clientY })
          setMenuOpen(true)
        }}
      >
        <div
          ref={setNodeRef}
          style={{
            transform: CSS.Transform.toString(transform),
            transition,
            zIndex: isDragging ? 10 : undefined,
            opacity: isDragging ? 0.8 : 1
          }}
          {...attributes}
          {...listeners}
          className={`group relative flex items-center h-full px-3 text-sm cursor-pointer select-none shrink-0 border-r border-border ${
            isActive
              ? 'bg-accent/40 text-foreground border-b-transparent'
              : 'bg-card text-muted-foreground hover:text-foreground hover:bg-accent/50'
          }`}
          onPointerDown={(e) => {
            if (e.button !== 0) {
              return
            }
            onActivate()
            listeners?.onPointerDown?.(e)
          }}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault()
            }
          }}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              e.stopPropagation()
              onClose()
            }
          }}
        >
          <Globe
            className={`w-3.5 h-3.5 mr-1.5 shrink-0 ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}
          />
          <span className="truncate max-w-[180px] mr-1.5">{getBrowserTabLabel(tab)}</span>
          {tab.loading && !tab.loadError && !isBlankBrowserTab(tab) && (
            <span className="mr-1.5 size-1.5 rounded-full bg-sky-500/80 shrink-0" />
          )}
          <button
            className={`flex items-center justify-center w-4 h-4 rounded-sm shrink-0 ${
              isActive
                ? 'text-muted-foreground hover:text-foreground hover:bg-muted'
                : 'text-transparent group-hover:text-muted-foreground hover:!text-foreground hover:!bg-muted'
            }`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
          >
            <X className="w-3 h-3" />
          </button>
        </div>
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
        <DropdownMenuContent
          className="min-w-[11rem] rounded-[11px] border-border/80 p-1 shadow-[0_16px_36px_rgba(0,0,0,0.24)]"
          sideOffset={0}
          align="start"
        >
          <DropdownMenuItem onSelect={() => onSplitGroup('up', tab.id)}>
            <Rows2 className="mr-1.5 size-3.5" />
            Split Up
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onSplitGroup('down', tab.id)}>
            <Rows2 className="mr-1.5 size-3.5" />
            Split Down
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onSplitGroup('left', tab.id)}>
            <Columns2 className="mr-1.5 size-3.5" />
            Split Left
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onSplitGroup('right', tab.id)}>
            <Columns2 className="mr-1.5 size-3.5" />
            Split Right
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onClose}>Close</DropdownMenuItem>
          <DropdownMenuItem onSelect={onCloseToRight} disabled={!hasTabsToRight}>
            Close Tabs To The Right
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => void window.api.shell.openUrl(openInBrowserUrl)}
            disabled={!isHttpUrl}
          >
            <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
            Open In Browser
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
