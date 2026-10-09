import { useEffect, useId, useRef } from 'react'
import { SquareArrowOutUpRight, XIcon } from 'lucide-react'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import { formatAgentTypeLabel } from '../../../../shared/agent-status/presentation/agent-type-label'
import { agentStateLabel } from '@/components/AgentStateDot'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  dashboardCardDisplayState,
  type DashboardCard,
  type DashboardRevealAgentArgs
} from '../../../../shared/dashboard-snapshot'
import { AgentTerminalPreview } from './AgentTerminalPreview'
import { AgentCardLastMessages, hasAgentCardLastMessages } from './AgentCardLastMessages'
import { terminalPreviewUnavailableMessage } from './terminal-preview-unavailable-message'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { cn } from '@/lib/class-names'

/** Routing payload for focusing an agent's pane in the main window. */
export type AgentRevealArgs = DashboardRevealAgentArgs

type AgentTerminalDialogProps = {
  /** The agent shown in the dialog; null renders the dialog closed. */
  card: DashboardCard | null
  onOpenChange: (open: boolean) => void
  /** Pop-outs reveal through IPC; in-window hosts activate the pane locally. */
  onReveal: (args: AgentRevealArgs) => void
  onBrowserForeground?: () => void
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
  onReveal,
  onBrowserForeground
}: AgentTerminalFrameProps): React.JSX.Element {
  const t = useTranslate()
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
          <AgentTypeIcon agentType={card.agentType} size={13} />
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
          <span className="sr-only">{t('dashboardPopout.terminal.close', 'Close')}</span>
        </Button>
      </div>
      {card.ptyId ? (
        <AgentTerminalPreview
          ptyId={card.ptyId}
          terminalInput={card.terminalInput ?? null}
          linkSource={
            onBrowserForeground
              ? {
                  worktreeId: card.worktreeId,
                  executionHostId: card.executionHostId,
                  tabId: card.tabId,
                  ptyId: card.ptyId
                }
              : undefined
          }
          onBrowserForeground={
            onBrowserForeground
              ? () => {
                  onOpenChange(false)
                  onBrowserForeground()
                }
              : undefined
          }
          className={previewClassName}
          onRequestClose={() => onOpenChange(false)}
        />
      ) : (
        <div className="scrollbar-sleek max-h-[calc(100vh-140px)] min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
          <div className="text-[11px] text-muted-foreground">
            {terminalPreviewUnavailableMessage({ hostKind: card.hostKind }, t)}
          </div>
          {hasAgentCardLastMessages(card) ? (
            <AgentCardLastMessages card={card} clamp={false} className="mt-2 gap-1.5" />
          ) : null}
        </div>
      )}
      <div className="flex shrink-0 items-center gap-1.5 px-2.5 py-1.5">
        <Button type="button" variant="outline" size="xs" className="ml-auto" onClick={reveal}>
          <SquareArrowOutUpRight className="size-3" />
          {t('dashboardPopout.terminal.focusWorktree', 'Open worktree')}
        </Button>
      </div>
    </>
  )
}

/** Board-owned dialogs survive bucket moves that remount cards; only an explicit user dismissal closes them. */
export function AgentTerminalDialog({
  card,
  onOpenChange,
  onReveal,
  onBrowserForeground
}: AgentTerminalDialogProps): React.JSX.Element {
  const focusHandoff = useRef(false)
  const changeOpen = (open: boolean): void => {
    focusHandoff.current = false
    onOpenChange(open)
  }
  const handoff = onBrowserForeground
    ? () => {
        focusHandoff.current = true
        onBrowserForeground()
      }
    : undefined
  const terminalEscape = useAppStore(
    (s) => s.settings?.experimentalAgentDashboardTerminalEscape ?? 'send-to-agent'
  )
  // Why: an IME's cancelling Esc can redispatch as an unmarked Escape with the same code and
  // timeStamp after compositionend; xterm drops it (_canceledKey), so it must not close either.
  const imeEscapeRef = useRef<Pick<KeyboardEvent, 'code' | 'timeStamp'> | null>(null)
  return (
    <Dialog open={card !== null} onOpenChange={changeOpen}>
      {card ? (
        <DialogContent
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            if (focusHandoff.current) {
              event.preventDefault()
            }
            focusHandoff.current = false
          }}
          // Override max-width at the same breakpoint as DialogContent’s sm:max-w-lg default.
          className="flex w-[calc(100vw-40px)] max-w-none flex-col gap-0 p-0 sm:max-w-none"
          // Place the close control in the compact header; the default absolute offsets assume dialog padding.
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
          // The preview owns focus after snapshot paint; prevent Radix from taking an earlier default target.
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
            onOpenChange={changeOpen}
            onReveal={onReveal}
            onBrowserForeground={handoff}
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
  onBrowserForeground,
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
        onBrowserForeground={onBrowserForeground}
      />
    </section>
  )
}
