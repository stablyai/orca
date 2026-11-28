import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { ResizeHandle } from '@/components/pane-resize/PaneSplitResizeHandle'
import { getNotificationWorkspaceLabels } from '@/attention/notification-workspace-labels'
import { resolveTerminalTabTitle } from '../../../../shared/workspace-layout/tab-groups/tab-title-resolution'
import { setCrossWorkspacePaneTerminalPortal } from '../activity/terminal-portal/activity-terminal-portal'
import { requestBackgroundTerminalWorktreeMount } from '../terminal/workspace-mounting/background-terminal-worktree-mount'
import { selectIsSleepingWorktree } from '../sidebar/workspace-actions/sleep/use-worktree-sleep-state'
import { selectCrossWorkspacePaneTab } from './cross-workspace-pane-tab'

const PORTAL_SLOT_ID = 'cross-workspace-pane'

function noop(): void {}

/** Divider and pane. Render them right after the workspace area, inside its flex row. */
export function CrossWorkspacePane({
  isOnScreen
}: {
  isOnScreen: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const pane = useAppStore((s) => s.crossWorkspacePane)
  const setPane = useAppStore((s) => s.setCrossWorkspacePane)
  const terminalTabId = useAppStore((s) => selectCrossWorkspacePaneTab(s)?.entityId ?? null)
  const sessionReady = useAppStore((s) => s.workspaceSessionReady)
  const rightSidebarOpen = useAppStore((s) => s.rightSidebarOpen)
  const worktreeId = pane?.worktreeId ?? null
  const paneTabId = pane?.tabId ?? null
  const asleep = useAppStore((s) => (worktreeId ? selectIsSleepingWorktree(s, worktreeId) : false))
  const workspaceLabel = useAppStore(
    useShallow((s) => (worktreeId ? getNotificationWorkspaceLabels(s, worktreeId) : null))
  )
  const title = useAppStore((s) => {
    const terminalTab = worktreeId
      ? s.tabsByWorktree[worktreeId]?.find((tab) => tab.id === terminalTabId)
      : undefined
    return terminalTab
      ? resolveTerminalTabTitle(
          terminalTab,
          s.settings?.tabAutoGenerateTitle === true,
          terminalTab.title
        )
      : ''
  })
  const [target, setTarget] = useState<HTMLDivElement | null>(null)
  const [focused, setFocused] = useState(false)

  useLayoutEffect(() => {
    if (!worktreeId || !terminalTabId || !target) {
      setCrossWorkspacePaneTerminalPortal(null)
      return
    }
    setCrossWorkspacePaneTerminalPortal({
      slotId: PORTAL_SLOT_ID,
      requestToken: `${PORTAL_SLOT_ID}:${worktreeId}:${terminalTabId}`,
      target,
      worktreeId,
      tabId: terminalTabId,
      paneKey: null,
      active: focused,
      hidden: !isOnScreen
    })
  }, [focused, isOnScreen, target, terminalTabId, worktreeId])
  useEffect(() => () => setCrossWorkspacePaneTerminalPortal(null), [])

  useEffect(() => {
    // Its own workspace may never have been opened in this window. A sleeping one stays asleep.
    if (worktreeId && terminalTabId && !asleep) {
      requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds: [terminalTabId] })
    }
  }, [asleep, terminalTabId, worktreeId])

  // Close with a tab that was showing and is gone. One never found since launch stays, so an offline host cannot clear it.
  const shownTabRef = useRef<string | null>(null)
  useEffect(() => {
    if (paneTabId === null || terminalTabId) {
      shownTabRef.current = paneTabId
    } else if (shownTabRef.current === paneTabId) {
      shownTabRef.current = null
      setPane(null)
    }
  }, [paneTabId, setPane, terminalTabId])

  const onRatioChange = useCallback(
    (workspaceRatio: number) => {
      const current = useAppStore.getState().crossWorkspacePane
      if (current) {
        setPane({ ...current, fraction: 1 - workspaceRatio })
      }
    },
    [setPane]
  )

  if (!pane) {
    return null
  }
  const removeLabel = t(
    'auto.components.cross.workspace.pane.CrossWorkspacePane.removeFromSidePane',
    'Remove from side pane'
  )
  let notice: string | null = null
  if (sessionReady && !terminalTabId) {
    notice = t(
      'auto.components.cross.workspace.pane.CrossWorkspacePane.tabUnavailable',
      'This tab is not open. It may have been closed, or its workspace is not loaded.'
    )
  } else if (sessionReady && asleep) {
    notice = t(
      'auto.components.cross.workspace.pane.CrossWorkspacePane.workspaceAsleep',
      'This workspace is asleep. Select it in the sidebar to wake it.'
    )
  }
  return (
    <>
      <ResizeHandle
        direction="horizontal"
        thin
        onResizeStart={noop}
        onRatioChange={onRatioChange}
      />
      <section
        data-cross-workspace-pane=""
        aria-label={t(
          'auto.components.cross.workspace.pane.CrossWorkspacePane.sidePane',
          'Side pane'
        )}
        className="flex min-h-0 min-w-0 flex-col bg-background"
        style={{ flex: `${pane.fraction} 1 0%` }}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setFocused(false)
          }
        }}
      >
        <div className="workspace-tab-drag-strip h-[4px] shrink-0 bg-tab-bar" />
        <div
          className="flex h-(--workspace-tab-row-height) shrink-0 items-center gap-1.5 border-b border-border bg-tab-bar pl-2.5 pr-1 text-xs"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {terminalTabId && workspaceLabel ? (
            <span className="max-w-1/2 shrink-0 truncate text-muted-foreground">
              {/* A folder project and its one workspace share a name. */}
              {workspaceLabel.repoLabel && workspaceLabel.repoLabel !== workspaceLabel.worktreeLabel
                ? `${workspaceLabel.repoLabel} · ${workspaceLabel.worktreeLabel}`
                : workspaceLabel.worktreeLabel}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate">{title}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={removeLabel}
                onClick={() => setPane(null)}
              >
                <X />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {removeLabel}
            </TooltipContent>
          </Tooltip>
          {/* The floating right-sidebar toggle and the window controls sit over this corner. */}
          {rightSidebarOpen ? null : (
            <div
              className="shrink-0"
              style={{ width: 'calc(40px + var(--window-controls-width, 0px))' }}
            />
          )}
        </div>
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div ref={setTarget} className="absolute inset-0 isolate min-h-0 min-w-0" />
          {notice ? (
            // Opaque: a sleeping workspace's terminal stays mounted underneath and takes no input.
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background p-4 text-center text-sm text-muted-foreground">
              {notice}
              <Button variant="outline" size="sm" onClick={() => setPane(null)}>
                {removeLabel}
              </Button>
            </div>
          ) : null}
        </div>
      </section>
    </>
  )
}
