import { useCallback, useEffect, useState } from 'react'
import { SquareArrowOutUpRight, XIcon } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { agentStateLabel } from '@/components/AgentStateDot'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { clampSidebarResizeWidth, useSidebarResize } from '@/hooks/useSidebarResize'
import { translate } from '@/i18n/i18n'
import {
  dashboardCardDisplayState,
  type DashboardCard,
  type DashboardRevealAgentArgs
} from '../../../../shared/dashboard-snapshot'
import { AgentChatPanel } from './AgentChatPanel'
import { AgentTerminalPreview } from './AgentTerminalPreview'
import {
  AGENT_DASHBOARD_INSPECTOR_MIN_WIDTH,
  AGENT_DASHBOARD_INSPECTOR_RESIZE_STEP,
  AGENT_DASHBOARD_INSPECTOR_VIEWPORT_GAP
} from './agent-dashboard-inspector-width'
import type { NativeChatPtyWriter } from '@/components/native-chat/native-chat-pty-writer'

/** Routing payload for focusing an agent's pane in the main window. */
export type AgentRevealArgs = DashboardRevealAgentArgs

type AgentDashboardInspectorDrawerProps = {
  card: DashboardCard
  width: number
  onOpenChange: (open: boolean) => void
  onReveal: (args: AgentRevealArgs) => void
  onWidthChange: (width: number) => void
  chatPtyWriter?: NativeChatPtyWriter
}

function viewportWidth(): number {
  return document.documentElement.clientWidth || window.innerWidth
}

/** Dashboard card details slide from the window edge without shrinking the board. */
export function AgentDashboardInspectorDrawer({
  card,
  width,
  onOpenChange,
  onReveal,
  onWidthChange,
  chatPtyWriter
}: AgentDashboardInspectorDrawerProps): React.JSX.Element {
  const [showTerminal, setShowTerminal] = useState(card.viewMode !== 'chat')
  const [currentViewportWidth, setCurrentViewportWidth] = useState(viewportWidth)
  const maxWidth = Math.max(0, currentViewportWidth - AGENT_DASHBOARD_INSPECTOR_VIEWPORT_GAP)
  const minWidth = Math.min(AGENT_DASHBOARD_INSPECTOR_MIN_WIDTH, maxWidth)
  const renderedWidth = clampSidebarResizeWidth(width, minWidth, maxWidth)
  const { containerRef, onResizeStart } = useSidebarResize<HTMLDivElement>({
    isOpen: true,
    width: renderedWidth,
    minWidth,
    maxWidth,
    deltaSign: 1,
    setWidth: onWidthChange
  })

  useEffect(() => {
    const updateViewportWidth = (): void => setCurrentViewportWidth(viewportWidth())
    window.addEventListener('resize', updateViewportWidth)
    return () => window.removeEventListener('resize', updateViewportWidth)
  }, [])

  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const direction = event.key === 'ArrowRight' ? 1 : -1
      const step = AGENT_DASHBOARD_INSPECTOR_RESIZE_STEP * (event.shiftKey ? 2 : 1)
      onWidthChange(clampSidebarResizeWidth(renderedWidth + direction * step, minWidth, maxWidth))
    },
    [maxWidth, minWidth, onWidthChange, renderedWidth]
  )
  const handleResizeStart = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      if (event.button === 0) {
        onResizeStart(event)
      }
    },
    [onResizeStart]
  )
  const reveal = useCallback(() => {
    onReveal({
      repoId: card.repoId,
      worktreeId: card.worktreeId,
      executionHostId: card.executionHostId,
      tabId: card.tabId,
      leafId: card.leafId
    })
    onOpenChange(false)
  }, [card, onOpenChange, onReveal])

  return (
    <Sheet open modal={false} onOpenChange={onOpenChange}>
      <SheetContent
        ref={containerRef}
        side="left"
        showCloseButton={false}
        overlayClassName="hidden"
        aria-describedby={undefined}
        className="w-[var(--agent-dashboard-inspector-width)] max-w-[calc(100vw-3rem)] p-0 sm:max-w-[calc(100vw-3rem)]"
        style={
          {
            '--agent-dashboard-inspector-width': `${renderedWidth}px`
          } as React.CSSProperties
        }
        onEscapeKeyDown={(event) => {
          if (event.target instanceof HTMLElement && event.target.closest('.xterm')) {
            event.preventDefault()
          }
        }}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div
          role="separator"
          aria-label={translate('dashboardPopout.inspector.resize', 'Resize agent details')}
          aria-orientation="vertical"
          aria-valuemax={Math.round(maxWidth)}
          aria-valuemin={Math.round(minWidth)}
          aria-valuenow={Math.round(renderedWidth)}
          tabIndex={0}
          className="group absolute inset-y-0 -right-1.5 z-20 flex w-3 cursor-col-resize touch-none justify-center outline-none"
          onMouseDown={handleResizeStart}
          onKeyDown={handleResizeKeyDown}
        >
          <div className="h-full w-px bg-transparent transition-colors group-hover:bg-ring/50 group-active:bg-ring group-focus-visible:bg-ring" />
        </div>
        <SheetTitle className="sr-only">
          {translate('dashboardPopout.inspector.title', 'Agent details')}
        </SheetTitle>
        {showTerminal ? (
          <div className="flex min-h-0 flex-1 flex-col bg-background text-foreground">
            <header className="flex items-center gap-1.5 border-b border-border px-2.5 py-2">
              <span className="inline-flex shrink-0">
                <AgentIcon agent={agentTypeToIconAgent(card.agentType)} size={13} />
              </span>
              <h2 className="text-[12px] leading-normal font-semibold">{card.worktreeName}</h2>
              <span className="text-[11px] text-muted-foreground">
                {formatAgentTypeLabel(card.agentType)} ·{' '}
                {agentStateLabel(dashboardCardDisplayState(card))}
              </span>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                aria-label={translate('dashboardPopout.terminal.close', 'Close')}
                className="ml-auto rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:outline-hidden"
              >
                <XIcon className="size-4" />
              </button>
            </header>
            {card.ptyId ? (
              <AgentTerminalPreview ptyId={card.ptyId} terminalInput={card.terminalInput ?? null} />
            ) : (
              <div className="px-2.5 py-2 text-[11px] text-muted-foreground">
                {translate(
                  'dashboardPopout.terminal.closed',
                  "No live terminal — this agent's pane has closed."
                )}
              </div>
            )}
            <div className="flex items-center justify-end border-t border-border px-2.5 py-1.5">
              <Button type="button" variant="outline" size="xs" onClick={reveal}>
                <SquareArrowOutUpRight className="size-3" />
                {translate('dashboardPopout.terminal.focusWorktree', 'Open worktree')}
              </Button>
            </div>
          </div>
        ) : (
          <AgentChatPanel
            card={card}
            onClose={() => onOpenChange(false)}
            onOpenTerminal={() => setShowTerminal(true)}
            ptyWriter={chatPtyWriter}
            className="m-0 h-full flex-none rounded-none border-0 bg-transparent shadow-none"
          />
        )}
      </SheetContent>
    </Sheet>
  )
}
