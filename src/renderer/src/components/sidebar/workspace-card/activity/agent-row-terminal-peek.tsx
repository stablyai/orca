import React, { useCallback, useEffect, useRef, useState } from 'react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { AgentTerminalPreview } from '@/components/dashboard-popout/AgentTerminalPreview'
import { terminalPreviewUnavailableMessage } from '@/components/dashboard-popout/terminal-preview-unavailable-message'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { getPtyIdForPaneKey } from '@/hooks/pane-key-pty-id'
import { useTranslate } from '@/i18n/use-translate'

// Long enough that a pointer crossing the sidebar opens nothing.
const PEEK_OPEN_DWELL_MS = 400

type PeekTarget = { ptyId: string | null }

/** Lets the user watch a sidebar agent without a tab switch; read-only so no stray key reaches it. */
export function AgentRowTerminalPeek({
  agent,
  children
}: {
  agent: Pick<DashboardAgentRowData, 'paneKey' | 'activationPaneKey'>
  children: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  // Child agents have no pane of their own; peek the pane a click activates.
  const paneKey = agent.activationPaneKey ?? agent.paneKey
  const [target, setTarget] = useState<PeekTarget | null>(null)
  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const removeWheelListenerRef = useRef<(() => void) | null>(null)

  const clearDwell = useCallback((): void => {
    if (dwellTimerRef.current !== null) {
      clearTimeout(dwellTimerRef.current)
    }
    dwellTimerRef.current = null
    removeWheelListenerRef.current?.()
    removeWheelListenerRef.current = null
  }, [])

  const armDwell = useCallback((): void => {
    if (dwellTimerRef.current !== null) {
      clearTimeout(dwellTimerRef.current)
    }
    dwellTimerRef.current = setTimeout(() => {
      clearDwell()
      // Resolve at open: the pane can rebind to another PTY between hovers.
      setTarget({ ptyId: getPtyIdForPaneKey(paneKey) })
    }, PEEK_OPEN_DWELL_MS)
  }, [clearDwell, paneKey])

  const close = useCallback((): void => {
    clearDwell()
    setTarget(null)
  }, [clearDwell])

  const handlePointerEnter = (event: React.PointerEvent): void => {
    if (event.pointerType === 'touch' || target !== null) {
      return
    }
    armDwell()
    if (removeWheelListenerRef.current) {
      return
    }
    // Rows scrolling under a resting pointer fire pointerenter; restart the dwell so scrolling never opens a peek.
    const onWheel = (): void => armDwell()
    window.addEventListener('wheel', onWheel, { capture: true, passive: true })
    removeWheelListenerRef.current = () =>
      window.removeEventListener('wheel', onWheel, { capture: true })
  }

  useEffect(() => clearDwell, [clearDwell])

  return (
    <HoverCard
      open={target !== null}
      // Only the dwell timer opens the card; the primitive still closes it on leave.
      onOpenChange={(open) => {
        if (!open) {
          close()
        }
      }}
    >
      <HoverCardTrigger
        asChild
        onPointerEnter={handlePointerEnter}
        onPointerLeave={clearDwell}
        // Capture phase: rows stop pointerdown bubbling, and a press must still cancel or close the peek.
        onPointerDownCapture={close}
      >
        <div className="min-w-0">{children}</div>
      </HoverCardTrigger>
      <HoverCardContent variant="agent-terminal-peek" side="right" align="start">
        {target?.ptyId ? (
          <AgentTerminalPreview
            ptyId={target.ptyId}
            claimGrid={false}
            interactive={false}
            className="h-full"
          />
        ) : target ? (
          // No live PTY means the agent's terminal exited; say so instead of a blank card.
          <div className="flex h-full items-center justify-center px-2.5 text-center text-[11px] text-muted-foreground">
            {terminalPreviewUnavailableMessage({ ptyId: null }, t)}
          </div>
        ) : null}
      </HoverCardContent>
    </HoverCard>
  )
}
