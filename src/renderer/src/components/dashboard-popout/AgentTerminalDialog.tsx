import { useCallback } from 'react'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { agentStateLabel } from '@/components/AgentStateDot'
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { AgentTerminalPreview } from './AgentTerminalPreview'
import { translate } from '@/i18n/i18n'

type AgentTerminalDialogProps = {
  /** The agent shown in the dialog; null renders the dialog closed. */
  card: DashboardCard | null
  onOpenChange: (open: boolean) => void
}

/**
 * The near-fullscreen live-terminal dialog for one agent. Hosted by the BOARD,
 * not the card: sending a message flips the agent's bucket, which remounts its
 * card in another column — a card-owned dialog would close mid-conversation.
 * Only an explicit close (button, click-outside, Esc outside the terminal)
 * dismisses it.
 */
export function AgentTerminalDialog({
  card,
  onOpenChange
}: AgentTerminalDialogProps): React.JSX.Element {
  const reveal = useCallback(() => {
    if (!card) {
      return
    }
    void window.api.dashboard.revealAgent({
      repoId: card.repoId,
      worktreeId: card.worktreeId,
      tabId: card.tabId,
      leafId: card.leafId
    })
  }, [card])

  return (
    <Dialog open={card !== null} onOpenChange={onOpenChange}>
      {card ? (
        <DialogContent
          showCloseButton={false}
          aria-describedby={undefined}
          // Why: sm:max-w-lg in DialogContent's base classes would defeat a bare
          // max-w-*, so the full-width override must carry the same breakpoint.
          className="flex w-[calc(100vw-40px)] max-w-none flex-col gap-0 p-0 sm:max-w-none"
          // Why: Esc must reach the agent (interrupt) when typing in the
          // terminal, not dismiss the dialog; xterm has already consumed the
          // keystroke by the time Radix sees it. Click-outside still closes.
          onEscapeKeyDown={(e) => {
            if (e.target instanceof HTMLElement && e.target.closest('.xterm')) {
              e.preventDefault()
            }
          }}
          // Why: the preview focuses its terminal once the snapshot paints;
          // Radix's default focus target would tug focus away first.
          onOpenAutoFocus={(e) => {
            if (card.ptyId) {
              e.preventDefault()
            }
          }}
        >
          <div className="flex items-center gap-1.5 px-2.5 py-2">
            <AgentIcon agent={agentTypeToIconAgent(card.agentType)} size={13} />
            <DialogTitle className="text-[12px] leading-normal font-semibold">
              {card.worktreeName}
            </DialogTitle>
            <span className="text-[11px] text-muted-foreground">
              {formatAgentTypeLabel(card.agentType)} · {agentStateLabel(card.dotState)}
            </span>
          </div>
          {card.ptyId ? (
            <AgentTerminalPreview ptyId={card.ptyId} />
          ) : (
            <div className="px-2.5 pb-2 text-[11px] text-muted-foreground">
              {translate(
                'dashboardPopout.terminal.closed',
                "No live terminal — this agent's pane has closed."
              )}
            </div>
          )}
          <div className="flex items-center justify-end gap-2 px-2.5 py-1.5">
            <DialogClose asChild>
              <Button type="button" variant="outline" size="xs">
                {translate('dashboardPopout.terminal.close', 'Close')}
              </Button>
            </DialogClose>
            <DialogClose asChild>
              <Button type="button" variant="outline" size="xs" onClick={reveal}>
                {translate('dashboardPopout.terminal.focusWorktree', 'Focus worktree')}
              </Button>
            </DialogClose>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
