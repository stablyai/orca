import React from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { PinnedTerminalPanel } from '../../../../shared/types'
import { PINNED_TERMINAL_PANELS_WORKTREE_ID } from '../../../../shared/pinned-terminal-panels'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import TerminalPane from '@/components/terminal-pane/TerminalPane'

const EMPTY_PANELS: readonly PinnedTerminalPanel[] = []

function PinnedTerminalPanelViewport({
  panel,
  visible,
  tabId,
  onPtyExit
}: {
  panel: PinnedTerminalPanel
  visible: boolean
  tabId: string
  onPtyExit: (panelId: string) => void
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
        worktreeId={PINNED_TERMINAL_PANELS_WORKTREE_ID}
        isActive={visible}
        isVisible={visible}
        showSplitButton={false}
        onPtyExit={() => onPtyExit(panel.id)}
        onCloseTab={() => onPtyExit(panel.id)}
      />
    </div>
  )
}

/** Hosts every visited pinned terminal panel; inactive ones stay mounted but
 *  parked so their TUIs (nvtop, btop, watch …) keep running off-screen. */
const PinnedTerminalPanelPage = React.memo(
  function PinnedTerminalPanelPage(): React.JSX.Element | null {
    useTranslation()
    const panels = useAppStore((s) => s.settings?.pinnedTerminalPanels ?? EMPTY_PANELS)
    const activeView = useAppStore((s) => s.activeView)
    const activePanelId = useAppStore((s) => s.activePinnedTerminalPanelId)
    const closePinnedTerminalPanelPage = useAppStore((s) => s.closePinnedTerminalPanelPage)
    const [tabIdByPanelId, setTabIdByPanelId] = React.useState<Readonly<Record<string, string>>>({})

    const pageVisible = activeView === 'terminal-panel' && activePanelId !== null
    const activePanel = panels.find((panel) => panel.id === activePanelId)

    // Why: the tab (and its PTY) is created on first visit, not at startup —
    // eight configured panels must not spawn eight shells on app boot.
    React.useEffect(() => {
      if (!pageVisible || activePanelId === null || tabIdByPanelId[activePanelId]) {
        return
      }
      const panel = panels.find((entry) => entry.id === activePanelId)
      if (!panel) {
        return
      }
      const state = useAppStore.getState()
      const tab = state.createTab(PINNED_TERMINAL_PANELS_WORKTREE_ID, undefined, undefined, {
        activate: false,
        quickCommandLabel: panel.title
      })
      state.queueTabStartupCommand(tab.id, { command: panel.command })
      setTabIdByPanelId((prev) => ({ ...prev, [activePanelId]: tab.id }))
    }, [pageVisible, activePanelId, panels, tabIdByPanelId])

    const releasePanelTab = React.useCallback((panelId: string) => {
      setTabIdByPanelId((prev) => {
        if (!prev[panelId]) {
          return prev
        }
        const next = { ...prev }
        delete next[panelId]
        return next
      })
    }, [])

    // Why: a panel deleted in Settings must release its PTY immediately — the
    // command keeps running otherwise, invisible, until app exit.
    React.useEffect(() => {
      const panelIds = new Set(panels.map((panel) => panel.id))
      setTabIdByPanelId((prev) => {
        const removed = Object.keys(prev).filter((panelId) => !panelIds.has(panelId))
        if (removed.length === 0) {
          return prev
        }
        const state = useAppStore.getState()
        const next = { ...prev }
        for (const panelId of removed) {
          state.closeTab(next[panelId], { reason: 'cleanup' })
          delete next[panelId]
        }
        return next
      })
    }, [panels])

    React.useEffect(() => {
      if (activeView === 'terminal-panel' && !activePanel) {
        closePinnedTerminalPanelPage()
      }
    }, [activeView, activePanel, closePinnedTerminalPanelPage])

    const mountedPanels = panels.filter((panel) => tabIdByPanelId[panel.id])
    if (mountedPanels.length === 0) {
      return null
    }

    return (
      <div className={cn('min-h-0 flex-1 flex-col', pageVisible ? 'flex' : 'hidden')}>
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-tight">
            {activePanel?.title ?? ''}
          </span>
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
        {mountedPanels.map((panel) => (
          <PinnedTerminalPanelViewport
            key={panel.id}
            panel={panel}
            tabId={tabIdByPanelId[panel.id]}
            visible={pageVisible && panel.id === activePanelId}
            onPtyExit={releasePanelTab}
          />
        ))}
      </div>
    )
  }
)

export default PinnedTerminalPanelPage
