import React from 'react'
import { useAppStore } from '@/store'
import { setSwapSource, useSwapState } from './swap-pane-session-coordinator'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { X, ArrowLeftRight } from 'lucide-react'

type SwapTargetOverlayProps = {
  worktreeId: string
}

export function SwapTargetOverlay({
  worktreeId
}: SwapTargetOverlayProps): React.JSX.Element | null {
  // Subscribe to swap source state. We query getSwapSource() whenever the store's terminalLayoutsByTabId changes,
  const terminalLayoutsByTabId = useAppStore((s) => s.terminalLayoutsByTabId)
  const swapTerminalPaneSessions = useAppStore((s) => s.swapTerminalPaneSessions)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)

  const source = useSwapState((s) => {
    if (s.sourceTabId && s.sourceLeafId) {
      return { tabId: s.sourceTabId, leafId: s.sourceLeafId }
    }
    return null
  })

  if (!source) {
    return null
  }

  // Find all candidate targets in the current worktree
  const worktreeTabs = tabsByWorktree[worktreeId] ?? []
  const handleCancel = () => {
    setSwapSource(null, null)
  }

  const handleSelectTarget = (targetTabId: string, targetLeafId: string) => {
    if (source.tabId === targetTabId && source.leafId === targetLeafId) {
      return
    }
    swapTerminalPaneSessions(source.tabId, source.leafId, targetTabId, targetLeafId)
    handleCancel()
  }

  return (
    <div className="absolute inset-0 bg-background/80 backdrop-blur-sm z-50 flex flex-col items-center justify-center p-6">
      <div className="bg-card border rounded-lg shadow-lg p-6 max-w-md w-full flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold">
            <ArrowLeftRight className="size-4 text-primary" />
            <span>{translate('auto.components.terminal.swap.title', 'Select Swap Target')}</span>
          </div>
          <Button variant="ghost" size="icon" className="size-8" onClick={handleCancel}>
            <X className="size-4" />
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          {translate(
            'auto.components.terminal.swap.description',
            'Select a terminal pane from any tab to swap sessions.'
          )}
        </p>

        <div className="flex flex-col gap-2 max-h-60 overflow-y-auto pr-1">
          {worktreeTabs.map((tab) => {
            const layout = terminalLayoutsByTabId[tab.id]
            if (!layout || !layout.ptyIdsByLeafId) {
              return null
            }
            const leafIds = Object.keys(layout.ptyIdsByLeafId)
            return (
              <div key={tab.id} className="flex flex-col gap-1 border-b pb-2 last:border-0">
                <span className="text-xs font-semibold text-muted-foreground px-2 py-1">
                  {tab.customTitle ?? tab.title}
                </span>
                {leafIds.map((leafId) => {
                  const isSource = source.tabId === tab.id && source.leafId === leafId
                  const ptyId = layout.ptyIdsByLeafId?.[leafId]
                  return (
                    <button
                      key={leafId}
                      disabled={isSource}
                      onClick={() => handleSelectTarget(tab.id, leafId)}
                      className={`flex items-center justify-between text-left text-sm px-3 py-2 rounded-md transition-colors ${
                        isSource
                          ? 'bg-muted text-muted-foreground cursor-not-allowed'
                          : 'hover:bg-accent hover:text-accent-foreground'
                      }`}
                    >
                      <span className="font-mono text-xs truncate max-w-[200px]">
                        Pane: {leafId.slice(0, 8)}
                      </span>
                      {ptyId && <span className="text-xs opacity-60">{ptyId.slice(0, 12)}</span>}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>

        <Button variant="outline" onClick={handleCancel} className="w-full">
          {translate('auto.components.terminal.swap.cancel', 'Cancel')}
        </Button>
      </div>
    </div>
  )
}
