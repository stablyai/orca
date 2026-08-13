import { useEffect, useId } from 'react'
import { SquareArrowOutUpRight, XIcon } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { agentStateLabel } from '@/components/AgentStateDot'
import { Button } from '@/components/ui/button'
import {
  dashboardCardDisplayState,
  type DashboardCard,
  type DashboardRevealAgentArgs
} from '../../../../shared/dashboard-snapshot'
import { AgentTerminalPreview } from './AgentTerminalPreview'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

/** Routing payload for focusing an agent's pane in the main window. */
export type AgentRevealArgs = DashboardRevealAgentArgs

type AgentTerminalSurfaceProps = {
  card: DashboardCard
  onOpenChange: (open: boolean) => void
  /** Focus the agent's pane. The pop-out relays over IPC; the in-window host
   *  activates the worktree/pane locally. */
  onReveal: (args: AgentRevealArgs) => void
}

type AgentTerminalFrameProps = AgentTerminalSurfaceProps & {
  title: React.ReactNode
  previewClassName?: string
}

function AgentTerminalFrame({
  card,
  title,
  previewClassName,
  onOpenChange,
  onReveal
}: AgentTerminalFrameProps): React.JSX.Element {
  const reveal = (): void => {
    onReveal({
      repoId: card.repoId,
      worktreeId: card.worktreeId,
      executionHostId: card.executionHostId,
      tabId: card.tabId,
      leafId: card.leafId
    })
    onOpenChange(false)
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-1.5 px-2.5 py-2">
        <span className="inline-flex shrink-0">
          <AgentIcon agent={agentTypeToIconAgent(card.agentType)} size={13} />
        </span>
        {title}
        <span className="text-[11px] text-muted-foreground">
          {formatAgentTypeLabel(card.agentType)} ·{' '}
          {agentStateLabel(dashboardCardDisplayState(card))}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="ml-auto opacity-70 hover:opacity-100"
          onClick={() => onOpenChange(false)}
        >
          <XIcon className="size-4" />
          <span className="sr-only">{translate('dashboardPopout.terminal.close', 'Close')}</span>
        </Button>
      </div>
      {card.ptyId ? (
        <AgentTerminalPreview
          ptyId={card.ptyId}
          terminalInput={card.terminalInput ?? null}
          className={previewClassName}
        />
      ) : (
        <div className="min-h-0 flex-1 px-2.5 pb-2 text-[11px] text-muted-foreground">
          {translate(
            'dashboardPopout.terminal.closed',
            "No live terminal — this agent's pane has closed."
          )}
        </div>
      )}
      <div className="flex shrink-0 items-center gap-1.5 px-2.5 py-1.5">
        <Button type="button" variant="outline" size="xs" className="ml-auto" onClick={reveal}>
          <SquareArrowOutUpRight className="size-3" />
          {translate('dashboardPopout.terminal.focusWorktree', 'Open worktree')}
        </Button>
      </div>
    </>
  )
}

/**
 * The live-terminal surface for one agent, docked beside the map. Hosted by the
 * VIEW, not the card: sending a message flips the agent's bucket, which remounts
 * its card — a card-owned panel would close mid-conversation.
 */
export function AgentTerminalPanel({
  card,
  onOpenChange,
  onReveal,
  className
}: AgentTerminalSurfaceProps & { className?: string }): React.JSX.Element {
  const titleId = useId()

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !(event.target instanceof HTMLElement && event.target.closest('.xterm'))
      ) {
        onOpenChange(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onOpenChange])

  return (
    <section
      role="dialog"
      data-state="open"
      aria-labelledby={titleId}
      className={cn(
        'm-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)]',
        className
      )}
    >
      <AgentTerminalFrame
        card={card}
        title={
          <h2 id={titleId} className="text-[12px] leading-normal font-semibold">
            {card.worktreeName}
          </h2>
        }
        previewClassName="h-auto min-h-0 flex-1"
        onOpenChange={onOpenChange}
        onReveal={onReveal}
      />
    </section>
  )
}
