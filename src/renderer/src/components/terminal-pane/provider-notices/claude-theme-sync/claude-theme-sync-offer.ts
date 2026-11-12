import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { TRAILING_ACTIONS_CLASS_NAMES } from '@/components/ui/sonner'
import { whenAgentTerminalAppears } from '../agent-presence/agent-terminal-presence'
import { getCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'

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

/**
 * The sync changes Claude Code on THIS computer. Hold the offer while the active workspace runs
 * elsewhere (Orca Cloud, a VM, SSH, an Orca server) or is still being created: a brand-new cloud
 * workspace is not in the cloud id list yet when its Claude terminal appears (RA-6).
 */
function isAwayFromThisComputer(state: AppState): boolean {
  if (state.activePendingCreationId) {
    return true
  }
  const id = state.activeWorktreeId
  if (!id) {
    return false
  }
  if (getCloudWorkspaceSnapshot().ids.has(id) || state.ephemeralVmRuntimesByWorkspaceId?.[id]) {
    return true
  }
  const host = state.activeWorkspaceExecutionHostId
  return Boolean(host && host !== LOCAL_EXECUTION_HOST_ID)
}

/**
 * The sync changes Claude Code on this computer, which an Orca Cloud workspace's Claude doesn't
 * use: hold the offer while one is active and make it once a local workspace is (RA-6).
 */
function offerOnLocalWorkspace(): () => void {
  if (!isAwayFromThisComputer(useAppStore.getState())) {
    showClaudeThemeSyncOffer()
    return () => {}
  }
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    const moved =
      state.activeWorktreeId !== previous.activeWorktreeId ||
      state.activePendingCreationId !== previous.activePendingCreationId ||
      state.activeWorkspaceExecutionHostId !== previous.activeWorkspaceExecutionHostId
    if (moved && !isAwayFromThisComputer(state)) {
      unsubscribe()
      showClaudeThemeSyncOffer()
    }
  })
  return unsubscribe
}

/** Offers theme sync once, when Claude Code first runs in an Orca terminal. */
export function useClaudeThemeSyncOffer(): void {
  const due = useAppStore(isOfferDue)

  useEffect(() => {
    // Why: a paired web client's Claude runs on the host, whose settings this window does not own.
    if (!due || isPairedWebClientWindow()) {
      return
    }
    let stopWaitingForLocal: () => void = () => {}
    const stopWatching = whenAgentTerminalAppears('claude', () => {
      stopWaitingForLocal = offerOnLocalWorkspace()
    })
    return () => {
      stopWatching()
      stopWaitingForLocal()
    }
  }, [due])
}
