import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { useModalReturnFocus } from '@/hooks/useModalReturnFocus'
import { OldTerminalDialog } from './OldTerminalDialog'
import { openTerminalBesideTab } from './open-terminal-beside-tab'
import { PaneBannerLearnMore, PaneTopWarningBanner } from './PaneTopWarningBanner'

// Why module scope: a pane remounts on tab switches, and Dismiss must hold for the app session.
const dismissedPtyIds = new Set<string>()

// Why a selection, not just saved accounts: with System default selected, this terminal already
// matches a new one.
function hasSelectedClaudeAccount(state: AppState): boolean {
  const settings = state.settings
  if (!settings || settings.claudeManagedAccounts.length === 0) {
    return false
  }
  const selection = settings.activeClaudeManagedAccountIdsByRuntime
  return Boolean(
    selection?.host ??
    settings.activeClaudeManagedAccountId ??
    Object.values(selection?.wsl ?? {}).some(Boolean)
  )
}

function useOpenedBeforeClaudeAccounts(ptyId: string, enabled: boolean): boolean {
  const [openedBefore, setOpenedBefore] = useState(false)
  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    void window.api.pty
      .openedBeforeClaudeAccounts(ptyId)
      .catch(() => false)
      .then((answer) => {
        if (!cancelled) {
          setOpenedBefore(answer)
        }
      })
    return () => {
      cancelled = true
      setOpenedBefore(false)
    }
  }, [enabled, ptyId])
  return openedBefore
}

/** For Claude in a terminal whose shell predates per-account folders: its `claude` ignores the selection. */
export function ClaudeOldTerminalBanner({
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
  const accountSelected = useAppStore(hasSelectedClaudeAccount)
  // Why either signal: a typed claude is seen by the process read, or by its hooks.
  const claudeInPane = useAppStore(
    (state) =>
      state.paneForegroundAgentByPaneKey[paneKey]?.agent === 'claude' ||
      state.agentStatusByPaneKey[paneKey]?.agentType === 'claude'
  )
  const openedBefore = useOpenedBeforeClaudeAccounts(
    ptyId,
    accountSelected && claudeInPane && !dismissed
  )
  const [dialogOpen, setDialogOpen] = useState(false)
  // Why: the dialog has no Radix trigger, so closing it would leave focus on document.body.
  const { captureReturnFocus, skipReturnFocus } = useModalReturnFocus(dialogOpen)
  if (!openedBefore && !dialogOpen) {
    return null
  }
  return (
    <>
      {openedBefore ? (
        <PaneTopWarningBanner
          title={translate(
            'terminal.claudeOldTerminalBanner.title',
            "This terminal was opened before Orca's Claude account update, so claude here uses System default's login."
          )}
          body={
            <PaneBannerLearnMore
              onClick={() => {
                captureReturnFocus()
                setDialogOpen(true)
              }}
            />
          }
          primaryAction={
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => openTerminalBesideTab(tabId)}
            >
              {translate('terminal.paneTopBanner.openNewTerminal', 'Open new terminal')}
            </Button>
          }
          onDismiss={() => {
            dismissedPtyIds.add(ptyId)
            setDismissed(true)
          }}
        />
      ) : null}
      <OldTerminalDialog
        open={dialogOpen}
        title={translate(
          'terminal.claudeOldTerminalBanner.dialogTitle',
          "Why claude here doesn't use the selected account"
        )}
        description={translate(
          'terminal.claudeOldTerminalBanner.dialogDescription',
          'Orca now keeps each Claude account in its own folder, and claude in a new terminal follows the account you select.'
        )}
        cause={translate(
          'terminal.claudeOldTerminalBanner.dialogCause',
          "Terminals opened before this update don't, so claude here signs in with System default's login. Open a new terminal to use the selected account."
        )}
        onOpenChange={(open) => {
          if (!open) {
            setDialogOpen(false)
          }
        }}
        onOpenNewTerminal={() => {
          // Why: a new terminal takes focus; only when none opens does focus return to this pane.
          if (openTerminalBesideTab(tabId)) {
            skipReturnFocus()
          }
          setDialogOpen(false)
        }}
      />
    </>
  )
}
