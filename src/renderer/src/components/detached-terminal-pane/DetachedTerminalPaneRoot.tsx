import { useEffect, useRef, useState } from 'react'
import TerminalPane from '@/components/terminal-pane/TerminalPane'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { applyDetachedTerminalTabSeed } from './detached-terminal-pane-seed'
import type { DetachedTerminalTabSeed } from '../../../../shared/types'

type DetachedTerminalPaneRootProps = {
  paneId: string
}

/** Flips the pop-out's PTY delivery interest on mount and back off on
 *  teardown, so byte streaming follows whichever window is actually showing
 *  the pane. See detachable-pane-window-manager.ts for the counterpart
 *  bookkeeping on the main-window side. */
function useDetachedRendererPtyDelivery(ptyId: string | null): void {
  useEffect(() => {
    if (!ptyId) {
      return
    }
    window.api.pty.setActiveRendererPty(ptyId, true)
    window.api.pty.setRendererPtyVisible(ptyId, true)
    return () => {
      window.api.pty.setActiveRendererPty(ptyId, false)
      window.api.pty.setRendererPtyVisible(ptyId, false)
    }
  }, [ptyId])
}

export function DetachedTerminalPaneRoot({
  paneId
}: DetachedTerminalPaneRootProps): React.JSX.Element | null {
  const [seed, setSeed] = useState<DetachedTerminalTabSeed | null>(null)
  const [activeSeedTabId, setActiveSeedTabId] = useState<string | null>(null)
  const [seedFailed, setSeedFailed] = useState(false)
  const reintegratingRef = useRef(false)
  const detachedTabs = seed ? [seed, ...(seed.additionalTabs ?? [])] : []
  const activeSeedTab =
    detachedTabs.find((entry) => entry.tab.id === activeSeedTabId) ?? detachedTabs[0] ?? null
  const activeStoreTab = useAppStore((state) =>
    activeSeedTab
      ? (state.tabsByWorktree[activeSeedTab.worktreeId]?.find(
          (tab) => tab.id === activeSeedTab.tab.id
        ) ?? null)
      : null
  )
  const activeTitle =
    activeStoreTab?.customTitle ??
    activeSeedTab?.tab.customTitle ??
    activeStoreTab?.title ??
    activeSeedTab?.tab.title ??
    null

  useEffect(() => {
    let disposed = false
    void window.api.pane
      .getDetachedTabSeed(paneId)
      .then((result) => {
        if (disposed) {
          return
        }
        if (!result) {
          setSeedFailed(true)
          return
        }
        applyDetachedTerminalTabSeed(result, result.tab.id)
        setSeed(result)
        setActiveSeedTabId(result.tab.id)
      })
      .catch(() => {
        if (!disposed) {
          setSeedFailed(true)
        }
      })
    return () => {
      disposed = true
    }
  }, [paneId])
  useEffect(() => {
    if (activeTitle) {
      document.title = activeTitle
    }
  }, [activeTitle])

  useDetachedRendererPtyDelivery(activeSeedTab?.ptyId ?? null)

  useEffect(() => {
    const ptyId = activeSeedTab?.ptyId
    if (!ptyId) {
      return
    }
    // Why: pre-hydrate scrollback before the live pty:data stream attaches,
    // so the first paint isn't a blank pane.
    void window.api.pty.getMainBufferSnapshot(ptyId).catch(() => null)
  }, [activeSeedTab?.ptyId])

  const handleSelectTab = (nextTabId: string): void => {
    const nextTab = detachedTabs.find((entry) => entry.tab.id === nextTabId)
    if (!nextTab || nextTab.tab.id === activeSeedTab?.tab.id) {
      return
    }
    setActiveSeedTabId(nextTab.tab.id)
    useAppStore.setState((state) => ({
      activeTabId: nextTab.tab.id,
      activeTabIdByWorktree: {
        ...state.activeTabIdByWorktree,
        [nextTab.worktreeId]: nextTab.tab.id
      },
      activeTabType: 'terminal',
      activeTabTypeByWorktree: {
        ...state.activeTabTypeByWorktree,
        [nextTab.worktreeId]: 'terminal'
      }
    }))
  }

  const handleCloseTab = (): void => {
    if (!seed || !activeSeedTab) {
      window.close()
      return
    }
    const remaining = detachedTabs.filter((entry) => entry.tab.id !== activeSeedTab.tab.id)
    if (remaining.length === 0) {
      // Last tab: kill the PTY and clear the manager's seed *before* closing
      // the window, so the native close's park flow finds no seed to
      // reintegrate — otherwise it reappears as an exited tab in the main
      // window (window.close() doesn't wait for pending IPC to resolve).
      void Promise.allSettled([
        activeSeedTab.ptyId ? window.api.pty.kill(activeSeedTab.ptyId) : Promise.resolve(),
        window.api.pane.removeTab(paneId, activeSeedTab.tab.id)
      ]).finally(() => {
        window.close()
      })
      return
    }
    // Replace the seed so the closed tab is gone from local UI state.
    const primary = remaining[0]
    const nextSeed: DetachedTerminalTabSeed = {
      ...primary,
      additionalTabs: remaining.slice(1).length > 0 ? remaining.slice(1) : undefined
    }
    setSeed(nextSeed)
    // Kill the closed tab's PTY — only the last tab's kill was wired up before.
    if (activeSeedTab.ptyId) {
      void window.api.pty.kill(activeSeedTab.ptyId)
    }
    // Notify the manager so the closed tab stays gone after reintegration.
    void window.api.pane.removeTab(paneId, activeSeedTab.tab.id)
    // Switch active tab to the first remaining entry without rebuilding the
    // entire store — only the active-tab tracking fields need to move.
    useAppStore.setState((state) => ({
      activeTabId: primary.tab.id,
      activeTabIdByWorktree: {
        ...state.activeTabIdByWorktree,
        [primary.worktreeId]: primary.tab.id
      },
      activeTabType: 'terminal' as const,
      activeTabTypeByWorktree: {
        ...state.activeTabTypeByWorktree,
        [primary.worktreeId]: 'terminal' as const
      }
    }))
    setActiveSeedTabId(primary.tab.id)
  }
  const handleReintegrate = (): void => {
    if (reintegratingRef.current) {
      return
    }
    reintegratingRef.current = true
    void window.api.pane.reintegrate(paneId).finally(() => {
      window.close()
    })
  }

  if (seedFailed) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {translate(
          'detachedTerminalPane.seedMissing',
          'This terminal is no longer available in this window.'
        )}
      </div>
    )
  }

  if (!seed || !activeSeedTab) {
    return null
  }

  return (
    <div className="flex h-full w-full flex-col">
      <div
        className={`flex shrink-0 items-center border-b border-border px-2 py-1 ${
          detachedTabs.length > 1 ? 'justify-between gap-2' : 'justify-end'
        }`}
      >
        {detachedTabs.length > 1 ? (
          <div
            className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
            role="tablist"
            aria-label={translate('detachedTerminalPane.tabs', 'Detached terminals')}
          >
            {detachedTabs.map((entry) => {
              const isActive = entry.tab.id === activeSeedTab.tab.id
              const label = entry.tab.customTitle ?? entry.tab.title ?? entry.tab.id
              return (
                <Button
                  key={entry.tab.id}
                  type="button"
                  variant={isActive ? 'secondary' : 'ghost'}
                  size="sm"
                  role="tab"
                  aria-selected={isActive}
                  data-active={isActive ? 'true' : 'false'}
                  aria-label={label}
                  className="max-w-48 truncate"
                  onClick={() => handleSelectTab(entry.tab.id)}
                >
                  {label}
                </Button>
              )
            })}
          </div>
        ) : null}
        <Button variant="ghost" size="sm" onClick={handleReintegrate}>
          {translate('detachedTerminalPane.reintegrate', 'Return to main window')}
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        <TerminalPane
          tabId={activeSeedTab.tab.id}
          worktreeId={activeSeedTab.worktreeId}
          isActive
          isVisible
          onPtyExit={() => undefined}
          onCloseTab={handleCloseTab}
        />
      </div>
    </div>
  )
}
