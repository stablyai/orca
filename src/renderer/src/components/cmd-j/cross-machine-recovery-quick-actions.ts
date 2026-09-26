import { History } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { requestCrossMachineRecoveryDialog } from '@/components/cross-machine-recovery/cross-machine-recovery-dialog-request'
import type { CmdJQuickAction } from './quick-actions'

export const RECOVER_SESSIONS_QUICK_ACTION_ID = 'recover-sessions'

function availability() {
  // Why: the web build's stub reports unsupported; recovery needs a local desktop Orca.
  return window.api.crossMachineRecovery.isSupported
    ? ({ available: true } as const)
    : ({ available: false, reason: 'client-action-unsupported' } as const)
}

export function getCrossMachineRecoveryQuickActions(): CmdJQuickAction[] {
  return [
    {
      id: RECOVER_SESSIONS_QUICK_ACTION_ID,
      kind: 'action',
      title: translate('components.cross-machine-recovery.quickAction.title', 'Recover Sessions'),
      description: translate(
        'components.cross-machine-recovery.quickAction.description',
        'Pick up workspaces and agent sessions from another computer.'
      ),
      icon: History,
      verbKeywords: [
        translate(
          'components.cross-machine-recovery.quickAction.verbs.recover',
          'recover sessions'
        ),
        translate('components.cross-machine-recovery.quickAction.verbs.pickUp', 'pick up work'),
        translate(
          'components.cross-machine-recovery.quickAction.verbs.otherMachine',
          'other computer'
        )
      ],
      isAvailable: availability,
      run: async () => {
        const current = availability()
        if (!current.available) {
          return { status: 'unavailable', reason: current.reason }
        }
        requestCrossMachineRecoveryDialog()
        return { status: 'ok' }
      }
    }
  ]
}
