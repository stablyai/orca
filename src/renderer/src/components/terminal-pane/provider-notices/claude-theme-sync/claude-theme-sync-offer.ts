import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { TRAILING_ACTIONS_CLASS_NAMES } from '@/components/ui/sonner'
import { whenAgentTerminalAppears } from '../agent-presence/agent-terminal-presence'

const OFFER_TOAST_ID = 'claude-theme-sync-offer'

function isOfferDue(state: AppState): boolean {
  return state.settings?.claudeCodeThemeSyncOffer === 'pending'
}

function showClaudeThemeSyncOffer(): void {
  const { updateSettings, updateSettingsOrThrow } = useAppStore.getState()
  // Why settle before showing: shown means answered, so a dismiss, quit or reload never asks again.
  void updateSettings({ claudeCodeThemeSyncOffer: 'settled' })
  toast(translate('terminal.claudeThemeSyncOffer.title', 'Match Claude Code to your Orca theme?'), {
    // Why a stable id: a late settings sync can't stack a second offer.
    id: OFFER_TOAST_ID,
    description: translate(
      'terminal.claudeThemeSyncOffer.description',
      'Claude Code on this computer would use your terminal colors and follow theme changes, including outside Orca. You can change this in Settings.'
    ),
    duration: Infinity,
    classNames: TRAILING_ACTIONS_CLASS_NAMES,
    action: {
      label: translate('terminal.claudeThemeSyncOffer.accept', 'Match theme'),
      onClick: () => {
        // Why confirm only after the write: a failed save must not claim the sync is on.
        updateSettingsOrThrow({ claudeCodeThemeSync: true }).then(
          () =>
            toast.success(
              translate('terminal.claudeThemeSyncOffer.accepted', 'Claude Code theme sync is on'),
              {
                description: translate(
                  'terminal.claudeThemeSyncOffer.acceptedDescription',
                  'New Claude Code sessions on this computer use your Orca theme.'
                )
              }
            ),
          () =>
            toast.error(
              translate(
                'terminal.claudeThemeSyncOffer.failed',
                'Could not turn on Claude Code theme sync'
              ),
              {
                description: translate(
                  'terminal.claudeThemeSyncOffer.failedDescription',
                  'Turn it on in Settings.'
                )
              }
            )
        )
      }
    },
    cancel: {
      label: translate('terminal.claudeThemeSyncOffer.decline', 'No thanks'),
      onClick: () => {}
    }
  })
}

/** Offers theme sync once, when Claude Code first runs in an Orca terminal. */
export function useClaudeThemeSyncOffer(): void {
  const due = useAppStore(isOfferDue)

  useEffect(() => {
    // Why: a paired web client's Claude runs on the host, whose settings this window does not own.
    if (!due || isPairedWebClientWindow()) {
      return
    }
    return whenAgentTerminalAppears('claude', showClaudeThemeSyncOffer)
  }, [due])
}
