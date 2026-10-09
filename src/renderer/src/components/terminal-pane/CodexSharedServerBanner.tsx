import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { isCodexSharedServerWarningEnabled } from '../../../../shared/codex-terminal-server-isolation'
import type { CodexSharedServerStatus } from '../../../../shared/codex-shared-server-command'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { useModalReturnFocus } from '@/hooks/useModalReturnFocus'
import { OldTerminalDialog } from './OldTerminalDialog'
import { CodexSharedServerFixDialog } from './CodexSharedServerFixDialog'
import { openTerminalBesideTab } from './open-terminal-beside-tab'
import { PaneBannerLearnMore, PaneTopWarningBanner } from './PaneTopWarningBanner'
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
              <PaneBannerLearnMore onClick={() => showDialog('oldTerminal')} />
            </>
          ),
          primaryAction: (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => openTerminalBesideTab(tabId)}
            >
              {translate('terminal.paneTopBanner.openNewTerminal', 'Open new terminal')}
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
              <PaneBannerLearnMore onClick={() => showDialog('fix')} />
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
        <PaneTopWarningBanner
          title={translate(
            'terminal.codexSharedServerBanner.title',
            'This Codex is sharing a server with your other Codex tabs'
          )}
          body={body}
          primaryAction={primaryAction}
          onDismiss={() => {
            dismissedPtyIds.add(ptyId)
            setDismissed(true)
          }}
          onDontShowAgain={() =>
            void useAppStore.getState().updateSettings({ codexSharedServerWarning: false })
          }
          onShown={retireCodexTerminalServerIsolationNotice}
        />
      ) : null}
      <OldTerminalDialog
        open={openDialog === 'oldTerminal'}
        title={translate(
          'terminal.codexSharedServerBanner.oldTerminalDialogTitle',
          'Why this Codex shares a server'
        )}
        description={translate(
          'terminal.codexSharedServerBanner.oldTerminalDialogRisk',
          'Codex sessions that share a server can end together, and agent status can be wrong.'
        )}
        cause={translate(
          'terminal.codexSharedServerBanner.oldTerminalDialogCause',
          'Older terminals still share a Codex server. Open a new terminal to run Codex on a separate server.'
        )}
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
