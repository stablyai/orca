import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Maximize2, Minimize2, Minus, TerminalSquare } from 'lucide-react'
import TabBar from '@/components/tab-bar/TabBar'
import TerminalPane from '@/components/terminal-pane/TerminalPane'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { useAppStore } from '@/store'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { TerminalTab } from '../../../../shared/types'
import { FloatingTerminalResizeHandles } from './FloatingTerminalResizeHandles'
import {
  clampFloatingTerminalBounds,
  getDefaultFloatingTerminalBounds,
  getMaximizedFloatingTerminalBounds,
  type FloatingTerminalPanelBounds
} from './floating-terminal-panel-bounds'
import { FloatingTerminalIconContextMenu } from './FloatingTerminalIconContextMenu'
const EMPTY_TERMINAL_TABS: TerminalTab[] = []

type FloatingTerminalPanelProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function FloatingTerminalToggleButton({
  open,
  onToggle
}: {
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const shortcutLabel =
    typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac') ? '⌘⌥T' : 'Ctrl+Alt+T'
  return (
    <FloatingTerminalIconContextMenu
      currentLocation="floating-button"
      className="fixed bottom-8 right-3 z-40"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="bg-card/95 shadow-xs"
            aria-label={open ? 'Minimize floating terminal' : 'Show floating terminal'}
            aria-pressed={open}
            onClick={onToggle}
          >
            <TerminalSquare className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent
          side="left"
          sideOffset={6}
        >{`${open ? 'Minimize' : 'Show'} floating terminal (${shortcutLabel})`}</TooltipContent>
      </Tooltip>
    </FloatingTerminalIconContextMenu>
  )
}

export function FloatingTerminalPanel({
  open,
  onOpenChange
}: FloatingTerminalPanelProps): React.JSX.Element | null {
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const activeTabIdByWorktree = useAppStore((s) => s.activeTabIdByWorktree)
  const expandedPaneByTabId = useAppStore((s) => s.expandedPaneByTabId)
  const createTab = useAppStore((s) => s.createTab)
  const closeTab = useAppStore((s) => s.closeTab)
  const setActiveTabForWorktree = useAppStore((s) => s.setActiveTabForWorktree)
  const setTabBarOrder = useAppStore((s) => s.setTabBarOrder)
  const setTabCustomTitle = useAppStore((s) => s.setTabCustomTitle)
  const setTabColor = useAppStore((s) => s.setTabColor)
  const setTabPaneExpanded = useAppStore((s) => s.setTabPaneExpanded)
  const tabBarOrder = useAppStore((s) => s.tabBarOrderByWorktree[FLOATING_TERMINAL_WORKTREE_ID])
  const floatingTerminalCwd = useAppStore((s) => s.settings?.floatingTerminalCwd ?? '~')

  const [cwd, setCwd] = useState<string | null>(null)
  const [bounds, setBounds] = useState(() => getDefaultFloatingTerminalBounds())
  const [maximized, setMaximized] = useState(false)
  const restoreBoundsRef = useRef<FloatingTerminalPanelBounds | null>(null)
  const normalizedInitialBoundsRef = useRef(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    left: number
    top: number
  } | null>(null)

  const tabs = tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? EMPTY_TERMINAL_TABS
  const activeTabId = activeTabIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? tabs[0]?.id ?? null

  useEffect(() => {
    if (!open || normalizedInitialBoundsRef.current || typeof window === 'undefined') {
      return
    }
    normalizedInitialBoundsRef.current = true
    const rightGap = window.innerWidth - bounds.left - bounds.width
    if (rightGap > 160) {
      setBounds(getDefaultFloatingTerminalBounds())
    }
  }, [bounds.left, bounds.width, open])

  useEffect(() => {
    void window.api.app
      .getFloatingTerminalCwd({
        path: floatingTerminalCwd
      })
      .then(setCwd)
  }, [floatingTerminalCwd])

  useEffect(() => {
    if (!open || tabs.length > 0) {
      return
    }
    const tab = createTab(FLOATING_TERMINAL_WORKTREE_ID, undefined, undefined, { activate: false })
    setActiveTabForWorktree(FLOATING_TERMINAL_WORKTREE_ID, tab.id)
  }, [createTab, open, setActiveTabForWorktree, tabs.length])

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null,
    [activeTabId, tabs]
  )
  const activeFloatingTabId = activeTab?.id ?? null

  useEffect(() => {
    if (!open || !activeFloatingTabId) {
      return
    }
    focusTerminalTabSurface(activeFloatingTabId)
  }, [activeFloatingTabId, open])

  const createFloatingTab = useCallback(() => {
    const tab = createTab(FLOATING_TERMINAL_WORKTREE_ID, undefined, undefined, { activate: false })
    setActiveTabForWorktree(FLOATING_TERMINAL_WORKTREE_ID, tab.id)
    const state = useAppStore.getState()
    const currentTabs = state.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []
    const stored = state.tabBarOrderByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []
    const validIds = new Set(currentTabs.map((entry) => entry.id))
    const order = stored.filter((id) => validIds.has(id) && id !== tab.id)
    for (const entry of currentTabs) {
      if (entry.id !== tab.id && !order.includes(entry.id)) {
        order.push(entry.id)
      }
    }
    order.push(tab.id)
    setTabBarOrder(FLOATING_TERMINAL_WORKTREE_ID, order)
    focusTerminalTabSurface(tab.id)
  }, [createTab, setActiveTabForWorktree, setTabBarOrder])

  const closeFloatingTab = useCallback(
    (tabId: string) => {
      closeTab(tabId)
    },
    [closeTab]
  )

  const closeOthers = useCallback(
    (tabId: string) => {
      for (const tab of tabs) {
        if (tab.id !== tabId) {
          closeTab(tab.id)
        }
      }
    },
    [closeTab, tabs]
  )

  const closeToRight = useCallback(
    (tabId: string) => {
      const index = tabs.findIndex((tab) => tab.id === tabId)
      if (index === -1) {
        return
      }
      for (const tab of tabs.slice(index + 1)) {
        closeTab(tab.id)
      }
    },
    [closeTab, tabs]
  )

  const toggleMaximized = useCallback(() => {
    setMaximized((current) => {
      if (current) {
        setBounds(restoreBoundsRef.current ?? getDefaultFloatingTerminalBounds())
        restoreBoundsRef.current = null
        return false
      }
      restoreBoundsRef.current = bounds
      setBounds(getMaximizedFloatingTerminalBounds())
      return true
    })
  }, [bounds])

  const handleDragStart = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (maximized) {
      return
    }
    if (event.button !== 0) {
      return
    }
    const target = event.target
    if (
      target instanceof HTMLElement &&
      target.closest(
        'button,input,textarea,select,[role="menuitem"],[data-testid="sortable-tab"],[data-floating-terminal-no-drag]'
      )
    ) {
      return
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: bounds.left,
      top: bounds.top
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handleDragMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }
    setBounds((prev) =>
      clampFloatingTerminalBounds({
        ...prev,
        left: drag.left + event.clientX - drag.startX,
        top: drag.top + event.clientY - drag.startY
      })
    )
  }

  const handleDragEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null
    }
  }

  return (
    <div
      ref={panelRef}
      data-floating-terminal-panel
      aria-hidden={!open}
      className={`fixed z-50 flex min-h-[280px] min-w-[420px] overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)] ${open ? 'opacity-100' : 'invisible pointer-events-none opacity-0'}`}
      style={{
        visibility: open ? 'visible' : 'hidden',
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height
      }}
      onMouseUp={(event) => {
        if (maximized) {
          return
        }
        const rect = event.currentTarget.getBoundingClientRect()
        setBounds((prev) =>
          clampFloatingTerminalBounds({ ...prev, width: rect.width, height: rect.height })
        )
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className="flex h-9 shrink-0 items-center border-b border-border bg-[var(--bg-titlebar,var(--card))]"
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onPointerCancel={handleDragEnd}
        >
          <div className="flex h-full min-w-0 flex-1">
            <TabBar
              tabs={tabs}
              activeTabId={activeTab?.id ?? null}
              worktreeId={FLOATING_TERMINAL_WORKTREE_ID}
              expandedPaneByTabId={expandedPaneByTabId}
              onActivate={(tabId) => setActiveTabForWorktree(FLOATING_TERMINAL_WORKTREE_ID, tabId)}
              onClose={closeFloatingTab}
              onCloseOthers={closeOthers}
              onCloseToRight={closeToRight}
              onNewTerminalTab={createFloatingTab}
              onNewBrowserTab={() => {}}
              terminalOnly
              onSetCustomTitle={setTabCustomTitle}
              onSetTabColor={setTabColor}
              onTogglePaneExpand={(tabId) =>
                setTabPaneExpanded(tabId, expandedPaneByTabId[tabId] !== true)
              }
              activeTabType="terminal"
              tabBarOrder={tabBarOrder}
            />
          </div>
          <div className="flex items-center gap-1 px-2" data-floating-terminal-no-drag>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={
                    maximized ? 'Restore floating terminal' : 'Maximize floating terminal'
                  }
                  aria-pressed={maximized}
                  onClick={toggleMaximized}
                >
                  {maximized ? (
                    <Minimize2 className="size-3.5" />
                  ) : (
                    <Maximize2 className="size-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {maximized ? 'Restore' : 'Maximize'}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Minimize floating terminal"
                  onClick={() => onOpenChange(false)}
                >
                  <Minus className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                Minimize
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden bg-background">
          {cwd
            ? tabs.map((tab) => (
                <div
                  key={`${tab.id}-${tab.generation ?? 0}`}
                  className={
                    tab.id === activeTab?.id ? 'absolute inset-0' : 'absolute inset-0 hidden'
                  }
                  aria-hidden={tab.id !== activeTab?.id}
                >
                  <TerminalPane
                    tabId={tab.id}
                    worktreeId={FLOATING_TERMINAL_WORKTREE_ID}
                    cwd={cwd}
                    isActive={tab.id === activeTab?.id}
                    isVisible={tab.id === activeTab?.id}
                    onPtyExit={() => closeTab(tab.id)}
                    onCloseTab={() => closeTab(tab.id)}
                  />
                </div>
              ))
            : null}
        </div>
      </div>
      {!maximized && <FloatingTerminalResizeHandles bounds={bounds} setBounds={setBounds} />}
    </div>
  )
}
