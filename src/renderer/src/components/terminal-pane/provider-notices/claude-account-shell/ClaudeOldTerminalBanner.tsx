import {
  getTerminalNoticeLifetime,
  isTerminalNoticeLifetimeCurrent,
  type TerminalNoticeLifetime
} from '../terminal-notice-lifetime'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { paneClaudeTarget } from '../../host-state/terminal-pane-claude-target'
import { useModalReturnFocus } from '@/hooks/useModalReturnFocus'
import { OldTerminalDialog } from '../terminal-upgrade/OldTerminalDialog'
import { openTerminalBesideTab } from '../../context-menu/open-terminal-beside-tab'
import {
  PaneBannerLearnMore,
  PaneTopWarningBanner
} from '../../appearance/pane-top-banner/PaneTopWarningBanner'

// System default already matches new terminals; key explicit selections so account switches recheck old shells.
function selectedClaudeAccountKey(state: AppState): string | null {
  const settings = state.settings
  if (!settings || settings.claudeManagedAccounts.length === 0) {
    return null
  }
  const selection = settings.activeClaudeManagedAccountIdsByRuntime
  const host = selection?.host ?? settings.activeClaudeManagedAccountId ?? null
  const wsl = Object.entries(selection?.wsl ?? {}).filter(([, id]) => id)
  return host || wsl.length > 0 ? JSON.stringify([host, wsl]) : null
}

function useOpenedBeforeClaudeAccounts(
  ptyId: string,
  tabId: string,
  selectionKey: string | null,
  lifetime: TerminalNoticeLifetime | undefined
): boolean {
  const [answer, setAnswer] = useState<{
    lifetime: TerminalNoticeLifetime
    openedBefore: boolean
  }>()
  useEffect(() => {
    const target = selectionKey ? paneClaudeTarget(tabId) : null
    // Why hidden without a target: only the pane's own runtime says which account it runs.
    if (!target || !lifetime) {
      return
    }
    let cancelled = false
    void window.api.pty
      .openedBeforeClaudeAccounts(ptyId, target)
      .catch(() => false)
      .then((answer) => {
        if (!cancelled && isTerminalNoticeLifetimeCurrent(lifetime)) {
          setAnswer({ lifetime, openedBefore: answer })
        }
      })
    return () => {
      cancelled = true
      setAnswer(undefined)
    }
  }, [selectionKey, ptyId, tabId, lifetime])
  return answer?.lifetime === lifetime && answer?.openedBefore === true
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
  const t = useTranslate()
  const paneKey = makePaneKey(tabId, leafId)
  const lifetime = getTerminalNoticeLifetime(ptyId)
  const [dismissedLifetime, setDismissedLifetime] = useState<TerminalNoticeLifetime>()
  const dismissed =
    lifetime !== undefined &&
    (dismissedLifetime === lifetime || lifetime.dismissed.has('claude-old-terminal'))
  const selectionKey = useAppStore(selectedClaudeAccountKey)
  // Why either signal: a typed claude is seen by the process read, or by its hooks.
  const claudeInPane = useAppStore(
    (state) =>
      state.paneForegroundAgentByPaneKey[paneKey]?.agent === 'claude' ||
      state.agentStatusByPaneKey[paneKey]?.agentType === 'claude'
  )
  const openedBefore = useOpenedBeforeClaudeAccounts(
    ptyId,
    tabId,
    claudeInPane && !dismissed ? selectionKey : null,
    lifetime
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
          title={t(
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
              {t('terminal.paneTopBanner.openNewTerminal', 'Open new terminal')}
            </Button>
          }
          onDismiss={() => {
            if (lifetime && isTerminalNoticeLifetimeCurrent(lifetime)) {
              lifetime.dismissed.add('claude-old-terminal')
            }
            setDismissedLifetime(lifetime)
          }}
        />
      ) : null}
      <OldTerminalDialog
        open={dialogOpen}
        title={t(
          'terminal.claudeOldTerminalBanner.dialogTitle',
          "Why claude here doesn't use the selected account"
        )}
        description={t(
          'terminal.claudeOldTerminalBanner.dialogDescription',
          'Orca now keeps each Claude account in its own folder, and claude in a new terminal follows the account you select.'
        )}
        cause={t(
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
