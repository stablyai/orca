import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { isCodexSharedServerWarningEnabled } from '../../../../shared/codex-terminal-server-isolation'
import type { CodexSharedServerStatus } from '../../../../shared/codex-shared-server-command'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { createFloatingWorkspaceTerminalTab } from '@/lib/floating-workspace-tab-creation'
import { revealFloatingWorkspacePanel } from '@/lib/floating-workspace-panel-reveal'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { useModalReturnFocus } from '@/hooks/useModalReturnFocus'
import { CodexOldTerminalDialog } from './CodexOldTerminalDialog'
import { CodexSharedServerFixDialog } from './CodexSharedServerFixDialog'
import { retireCodexTerminalServerIsolationNotice } from './codex-terminal-server-isolation-notice'

// Why a ladder: Codex joins or starts the server a few seconds after its process appears.
const CHECK_DELAYS_MS = [1_000, 4_000, 10_000] as const
// Why module scope: a pane remounts on tab switches, and × must hold for the app session.
const dismissedPtyIds = new Set<string>()

/** Asks on the ladder until an answer is yes; returns a cancel that drops any later answer. */
function askUntilOnSharedServer(
  ask: (ptyId: string) => Promise<CodexSharedServerStatus>,
  ptyId: string,
  onJoined: (status: CodexSharedServerStatus) => void
): () => void {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = (attempt: number): void => {
    timer = setTimeout(() => {
      void ask(ptyId)
        .catch((): CodexSharedServerStatus => ({ joined: false }))
        .then((status) => {
          if (cancelled) {
            return
          }
          if (status.joined) {
            onJoined(status)
          } else if (attempt + 1 < CHECK_DELAYS_MS.length) {
            schedule(attempt + 1)
          }
        })
    }, CHECK_DELAYS_MS[attempt])
  }
  schedule(0)
  return () => {
    cancelled = true
    clearTimeout(timer)
  }
}

function usePaneCodexSharedServerStatus(
  ptyId: string,
  enabled: boolean,
  recheck: number
): CodexSharedServerStatus | null {
  const [status, setStatus] = useState<CodexSharedServerStatus | null>(null)
  useEffect(() => {
    if (!enabled) {
      return
    }
    const cancel = askUntilOnSharedServer(window.api.pty.isCodexOnSharedServer, ptyId, setStatus)
    return () => {
      cancel()
      setStatus(null)
    }
  }, [enabled, ptyId, recheck])
  return status
}

/** Opens a new terminal where this tab lives; a new terminal's shell has Orca's codex wrapper. */
function openTerminalBesideTab(terminalTabId: string): boolean {
  const state = useAppStore.getState()
  const tab = Object.values(state.unifiedTabsByWorktree)
    .flat()
    .find(
      (candidate) => candidate.contentType === 'terminal' && candidate.entityId === terminalTabId
    )
  if (!tab) {
    return false
  }
  if (tab.worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    revealFloatingWorkspacePanel(state)
    void createFloatingWorkspaceTerminalTab(state)
    return true
  }
  // Why always: Activity can show this pane behind its own view even when its workspace is active.
  if (activateAndRevealWorkspace(tab.worktreeId) === false) {
    return false
  }
  void useAppStore.getState().openNewTerminalTabInActiveWorkspace(tab.groupId)
  return true
}

/** Reserves the banner's height at the top of its pane so the terminal refits below it. */
function useReservePaneTopSpace(): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const banner = ref.current
    const pane = banner?.parentElement
    if (!banner || !pane) {
      return
    }
    const reserve = (): void => {
      pane.style.setProperty('--orca-pane-top-banner-height', `${banner.offsetHeight}px`)
    }
    reserve()
    const observer = new ResizeObserver(reserve)
    observer.observe(banner)
    return () => {
      observer.disconnect()
      pane.style.removeProperty('--orca-pane-top-banner-height')
    }
  }, [])
  return ref
}

export function CodexSharedServerBanner({
  ptyId,
  tabId,
  leafId
}: {
  ptyId: string
  tabId: string
  leafId: string
}): React.JSX.Element | null {
  const paneKey = makePaneKey(tabId, leafId)
  const [dismissed, setDismissed] = useState(() => dismissedPtyIds.has(ptyId))
  const warningEnabled = useAppStore(
    (state) => state.settings !== null && isCodexSharedServerWarningEnabled(state.settings)
  )
  // Why either signal: a typed codex is seen by the process read, or by its hooks when that read has no command marks.
  const codexInPane = useAppStore(
    (state) =>
      state.paneForegroundAgentByPaneKey[paneKey]?.agent === 'codex' ||
      state.agentStatusByPaneKey[paneKey]?.agentType === 'codex'
  )
  // Why a recheck: after the fix stops the server, the banner hides unless a new one is joined.
  const [recheck, setRecheck] = useState(0)
  const status = usePaneCodexSharedServerStatus(
    ptyId,
    warningEnabled && codexInPane && !dismissed,
    recheck
  )
  const [openDialog, setOpenDialog] = useState<'fix' | 'oldTerminal' | null>(null)
  // Why: neither dialog has a Radix trigger, so closing it would leave focus on document.body.
  const { captureReturnFocus, skipReturnFocus } = useModalReturnFocus(openDialog !== null)
  const showDialog = (dialog: 'fix' | 'oldTerminal'): void => {
    captureReturnFocus()
    setOpenDialog(dialog)
  }
  // Why an open dialog keeps it: this pane's Codex can end mid-dialog (Stop server does it), and
  // the dialog must still close normally so focus returns.
  if (!status && openDialog === null) {
    return null
  }
  const { body, primaryAction } =
    status?.joined && status.openedBeforeWrapper
      ? {
          body: (
            <>
              {translate(
                'terminal.codexSharedServerBanner.openedBeforeUpdateBody',
                'This terminal was opened before Orca started giving each Codex its own server.'
              )}{' '}
              <LearnMoreLink onClick={() => showDialog('oldTerminal')} />
            </>
          ),
          primaryAction: (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => openTerminalBesideTab(tabId)}
            >
              {translate('terminal.codexSharedServerBanner.openNewTerminal', 'Open new terminal')}
            </Button>
          )
        }
      : {
          body: (
            <>
              {translate(
                'terminal.codexSharedServerBanner.body',
                'Sessions may end unexpectedly, and agent status may be wrong.'
              )}{' '}
              <LearnMoreLink onClick={() => showDialog('fix')} />
            </>
          ),
          primaryAction: (
            <Button type="button" variant="outline" size="xs" onClick={() => showDialog('fix')}>
              {translate('terminal.codexSharedServerBanner.fix', 'Fix')}
            </Button>
          )
        }
  const closeDialog = (open: boolean): void => {
    if (!open) {
      setOpenDialog(null)
    }
  }
  return (
    <>
      {status ? (
        <CodexSharedServerBannerFrame
          body={body}
          primaryAction={primaryAction}
          onDismiss={() => {
            dismissedPtyIds.add(ptyId)
            setDismissed(true)
          }}
          onDontShowAgain={() =>
            void useAppStore.getState().updateSettings({ codexSharedServerWarning: false })
          }
        />
      ) : null}
      <CodexOldTerminalDialog
        open={openDialog === 'oldTerminal'}
        onOpenChange={closeDialog}
        onOpenNewTerminal={() => {
          // Why: a new terminal takes focus; only when none opens does focus return to this pane.
          if (openTerminalBesideTab(tabId)) {
            skipReturnFocus()
          }
          setOpenDialog(null)
        }}
      />
      <CodexSharedServerFixDialog
        ptyId={ptyId}
        open={openDialog === 'fix'}
        onOpenChange={closeDialog}
        onServerStopped={() => setRecheck((count) => count + 1)}
      />
    </>
  )
}

function LearnMoreLink({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className="text-foreground underline underline-offset-2 hover:text-foreground/80"
      onClick={onClick}
    >
      {translate('terminal.codexSharedServerBanner.learnMore', 'Learn more')}
    </button>
  )
}

function CodexSharedServerBannerFrame({
  body,
  primaryAction,
  onDismiss,
  onDontShowAgain
}: {
  body: React.ReactNode
  primaryAction: React.ReactNode
  onDismiss: () => void
  onDontShowAgain: () => void
}): React.JSX.Element {
  const ref = useReservePaneTopSpace()
  useEffect(retireCodexTerminalServerIsolationNotice, [])

  return (
    <div
      ref={ref}
      role="status"
      // Why pr-16: the pane's own split/close controls float over its top-right corner.
      className="pane-top-banner @container border-b border-status-warning-border bg-status-warning-background py-2 pr-16 pl-3 text-xs"
    >
      {/* Why a container query: split panes are narrow, so actions drop below the text there.
          Narrow and wide variants never share a property, so an unlayered utility cannot override them. */}
      <div className="@[44rem]:flex @[44rem]:items-center @[44rem]:gap-2">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <TriangleAlert
            className="mt-0.5 size-4 shrink-0 text-status-warning"
            aria-hidden="true"
          />
          <div className="min-w-0 leading-5">
            <p className="font-medium text-foreground">
              {translate(
                'terminal.codexSharedServerBanner.title',
                'This Codex is sharing a server with your other Codex tabs'
              )}
            </p>
            <p className="text-muted-foreground">{body}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1 @[44rem]:shrink-0 @max-[44rem]:mt-1.5 @max-[44rem]:pl-6.5">
          {primaryAction}
          <Button type="button" variant="ghost" size="xs" onClick={onDontShowAgain}>
            {translate('terminal.codexSharedServerBanner.dontShowAgain', "Don't show again")}
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={onDismiss}>
            {translate('terminal.codexSharedServerBanner.dismiss', 'Dismiss')}
          </Button>
        </div>
      </div>
    </div>
  )
}
