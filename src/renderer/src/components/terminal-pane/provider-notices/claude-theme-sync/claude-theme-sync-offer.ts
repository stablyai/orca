import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { whenAgentTerminalAppears } from '../agent-presence/agent-terminal-presence'

const OFFER_TOAST_ID = 'claude-theme-sync-offer'

function isOfferDue(state: AppState): boolean {
  return state.settings?.claudeCodeThemeSyncOffer === 'pending'
}

function showClaudeThemeSyncOffer(): void {
  const { updateSettings } = useAppStore.getState()
  // Why settle before showing: shown means answered, so a dismiss, quit or reload never asks again.
  void updateSettings({ claudeCodeThemeSyncOffer: 'settled' })
  toast(translate('terminal.claudeThemeSyncOffer.title', 'Match Claude Code to your Orca theme?'), {
    // Why a stable id: a late settings sync can't stack a second offer.
    id: OFFER_TOAST_ID,
    description: translate(
      'terminal.claudeThemeSyncOffer.description',
      'Claude Code would use your terminal colors and follow theme changes, including outside Orca. You can change this in Settings.'
    ),
    duration: Infinity,
    action: {
      label: translate('terminal.claudeThemeSyncOffer.accept', 'Match Theme'),
      onClick: () => {
        void updateSettings({ claudeCodeThemeSync: true })
        toast.success(translate('terminal.claudeThemeSyncOffer.accepted', 'Theme sync is on'), {
          description: translate(
            'terminal.claudeThemeSyncOffer.acceptedDescription',
            'Claude Code sessions use your Orca theme from their next start.'
          )
        })
      }
    },
    cancel: {
      label: translate('terminal.claudeThemeSyncOffer.decline', 'Not Now'),
      onClick: () => {}
    }
  })
}

/** Offers theme sync to profiles that predate it, once, when Claude Code first runs in an Orca terminal. */
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
