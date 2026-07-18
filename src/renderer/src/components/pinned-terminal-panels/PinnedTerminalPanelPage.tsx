import React from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { PinnedTerminalPanel } from '../../../../shared/types'
import { pinnedTerminalPanelWorktreeId } from '../../../../shared/pinned-terminal-panels'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import TerminalPane from '@/components/terminal-pane/TerminalPane'

const EMPTY_PANELS: readonly PinnedTerminalPanel[] = []

function PinnedTerminalPanelViewport({
  panel,
  visible,
  tabId,
  worktreeId,
  onPtyExit
}: {
  panel: PinnedTerminalPanel
  visible: boolean
  tabId: string
  worktreeId: string
  onPtyExit: (worktreeId: string, tabId: string) => void
}): React.JSX.Element {
  return (
    <div
      // Why: TerminalPane positions xterm layers absolutely; without a
      // positioned ancestor they anchor to the page and cover the header.
      className={cn(
        'relative min-h-0 flex-1 flex-col overflow-hidden',
        visible ? 'flex' : 'hidden'
      )}
      data-pinned-terminal-panel-id={panel.id}
    >
      <TerminalPane
        tabId={tabId}
        worktreeId={worktreeId}
        isActive={visible}
        isVisible={visible}
        showSplitButton={false}
        onPtyExit={() => onPtyExit(worktreeId, tabId)}
        onCloseTab={() => onPtyExit(worktreeId, tabId)}
      />
    </div>
  )
}

/** Hosts every visited pinned terminal panel; inactive ones stay mounted but
 *  parked so their TUIs (nvtop, btop, watch …) keep running off-screen. Each
 *  panel owns a per-panel sentinel worktree id, which is what routes its PTY
 *  to the panel's configured SSH host (or local) and lets tabs from a prior
 *  app run be re-adopted instead of leaked. */
const PinnedTerminalPanelPage = React.memo(
  function PinnedTerminalPanelPage(): React.JSX.Element | null {
    useTranslation()
    const panels = useAppStore((s) => s.settings?.pinnedTerminalPanels ?? EMPTY_PANELS)
    const activeView = useAppStore((s) => s.activeView)
    const activePanelId = useAppStore((s) => s.activePinnedTerminalPanelId)
    const closePinnedTerminalPanelPage = useAppStore((s) => s.closePinnedTerminalPanelPage)
    const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)

    const pageVisible = activeView === 'terminal-panel' && activePanelId !== null
    const activePanel = panels.find((panel) => panel.id === activePanelId)

    // Why: the tab (and its PTY) is created on first visit, not at startup —
    // eight configured panels must not spawn eight shells on app boot. A tab
    // surviving from a prior run (session restore) is adopted, not duplicated.
    React.useEffect(() => {
      if (!pageVisible || activePanelId === null) {
        return
      }
      const panel = panels.find((entry) => entry.id === activePanelId)
      if (!panel) {
        return
      }
      const worktreeId = pinnedTerminalPanelWorktreeId(panel.id)
      const state = useAppStore.getState()
      if ((state.tabsByWorktree[worktreeId] ?? []).length > 0) {
        return
      }
      const tab = state.createTab(worktreeId, undefined, undefined, {
        activate: false,
        quickCommandLabel: panel.title
      })
      state.queueTabStartupCommand(tab.id, { command: panel.command })
    }, [pageVisible, activePanelId, panels])

    const releasePanelTab = React.useCallback((worktreeId: string, tabId: string) => {
      const state = useAppStore.getState()
      if ((state.tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === tabId)) {
        state.closeTab(tabId, { reason: 'cleanup' })
      }
    }, [])

    // Why: a panel deleted in Settings must release its PTY immediately — the
    // command keeps running otherwise, invisible, until app exit.
    React.useEffect(() => {
      const panelWorktreeIds = new Set(
        panels.map((panel) => pinnedTerminalPanelWorktreeId(panel.id))
      )
      const state = useAppStore.getState()
      for (const worktreeId of Object.keys(state.tabsByWorktree)) {
        if (!worktreeId.startsWith(pinnedTerminalPanelWorktreeId(''))) {
          continue
        }
        if (panelWorktreeIds.has(worktreeId)) {
          continue
        }
        for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
          state.closeTab(tab.id, { reason: 'cleanup' })
        }
      }
    }, [panels])

    React.useEffect(() => {
      if (activeView === 'terminal-panel' && !activePanel) {
        closePinnedTerminalPanelPage()
      }
    }, [activeView, activePanel, closePinnedTerminalPanelPage])

    const mountedPanels = panels
      .map((panel) => {
        const worktreeId = pinnedTerminalPanelWorktreeId(panel.id)
        const tab = (tabsByWorktree[worktreeId] ?? [])[0]
        return tab ? { panel, worktreeId, tabId: tab.id } : null
      })
      .filter((entry): entry is { panel: PinnedTerminalPanel; worktreeId: string; tabId: string } =>
        Boolean(entry)
      )
    if (mountedPanels.length === 0) {
      return null
    }

    return (
      <div className={cn('min-h-0 flex-1 flex-col', pageVisible ? 'flex' : 'hidden')}>
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-tight">
            {activePanel?.title ?? ''}
          </span>
          {activePanel?.host ? (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {activePanel.host}
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={translate(
              'auto.components.pinned-terminal-panels.PinnedTerminalPanelPage.close',
              'Close panel'
            )}
            onClick={closePinnedTerminalPanelPage}
          >
            <X className="size-3.5" strokeWidth={1.75} />
          </Button>
        </div>
        {mountedPanels.map(({ panel, worktreeId, tabId }) => (
          <PinnedTerminalPanelViewport
            key={panel.id}
            panel={panel}
            worktreeId={worktreeId}
            tabId={tabId}
            visible={pageVisible && panel.id === activePanelId}
            onPtyExit={releasePanelTab}
          />
        ))}
      </div>
    )
  }
)

export default PinnedTerminalPanelPage
