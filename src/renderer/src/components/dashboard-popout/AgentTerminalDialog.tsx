import { useEffect, useId, useRef } from 'react'
import { SquareArrowOutUpRight, XIcon } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { agentStateLabel } from '@/components/AgentStateDot'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  dashboardCardDisplayState,
  type DashboardCard,
  type DashboardRevealAgentArgs
} from '../../../../shared/dashboard-snapshot'
import { AgentTerminalPreview } from './AgentTerminalPreview'
import { terminalPreviewUnavailableMessage } from './terminal-preview-unavailable-message'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import { cn } from '@/lib/utils'

/** Routing payload for focusing an agent's pane in the main window. */
export type AgentRevealArgs = DashboardRevealAgentArgs

type AgentTerminalDialogProps = {
  /** The agent shown in the dialog; null renders the dialog closed. */
  card: DashboardCard | null
  onOpenChange: (open: boolean) => void
  /** Focus the agent's pane. The pop-out relays over IPC; the in-window host
   *  activates the worktree/pane locally. */
  onReveal: (args: AgentRevealArgs) => void
}

type AgentTerminalFrameProps = Omit<AgentTerminalDialogProps, 'card'> & {
  card: DashboardCard
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
          {terminalPreviewUnavailableMessage({ hostKind: card.hostKind })}
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
 * The near-fullscreen live-terminal dialog for one agent. Hosted by the BOARD,
 * not the card: sending a message flips the agent's bucket, which remounts its
 * card in another column — a card-owned dialog would close mid-conversation.
 * Only an explicit close (button, click-outside, Esc outside the terminal, or
 * Esc inside it when the board's Esc setting is 'close-dialog') dismisses it.
 */
export function AgentTerminalDialog({
  card,
  onOpenChange,
  onReveal
}: AgentTerminalDialogProps): React.JSX.Element {
  const terminalEscape = useAppStore(
    (s) => s.settings?.experimentalAgentDashboardTerminalEscape ?? 'send-to-agent'
  )
  // Why: an IME's cancelling Esc can redispatch as an unmarked Escape with the same code and
  // timeStamp after compositionend; xterm drops it (_canceledKey), so it must not close either.
  const imeEscapeRef = useRef<Pick<KeyboardEvent, 'code' | 'timeStamp'> | null>(null)
  return (
    <Dialog open={card !== null} onOpenChange={onOpenChange}>
      {card ? (
        <DialogContent
          aria-describedby={undefined}
          // Why: sm:max-w-lg in DialogContent's base classes would defeat a bare
          // max-w-*, so the full-width override must carry the same breakpoint.
          className="flex w-[calc(100vw-40px)] max-w-none flex-col gap-0 p-0 sm:max-w-none"
          // Why: the default close X sits at top-4/right-4 (tuned for p-6
          // dialogs), which misaligns against this p-0 compact header; render
          // it inside the header row instead so it centers with the title.
          showCloseButton={false}
          onKeyDownCapture={({ nativeEvent: e }) => {
            if (isImeOwnedKeyboardEvent(e) && (e.key === 'Escape' || e.code === 'Escape')) {
              imeEscapeRef.current = { code: e.code, timeStamp: e.timeStamp }
            }
          }}
          // Why: Radix hears Esc in document capture, BEFORE xterm's textarea listener,
          // and xterm ignores defaultPrevented — preventDefault only keeps the dialog open.
          onEscapeKeyDown={(e) => {
            if (!(e.target instanceof HTMLElement && e.target.closest('.xterm'))) {
              return
            }
            e.preventDefault()
            const imeEscape = imeEscapeRef.current
            if (imeEscape?.code === e.code && imeEscape.timeStamp === e.timeStamp) {
              imeEscapeRef.current = null
              return
            }
            if (terminalEscape === 'close-dialog') {
              // Why: stopping here keeps Esc from xterm; closing directly survives an earlier listener's preventDefault.
              e.stopPropagation()
              onOpenChange(false)
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
          <AgentTerminalFrame
            card={card}
            title={
              <DialogTitle className="text-[12px] leading-normal font-semibold">
                {card.worktreeName}
              </DialogTitle>
            }
            onOpenChange={onOpenChange}
            onReveal={onReveal}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  )
}

export function AgentTerminalPanel({
  card,
  onOpenChange,
  onReveal,
  className
}: Omit<AgentTerminalDialogProps, 'card'> & {
  card: DashboardCard
  className?: string
}): React.JSX.Element {
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
