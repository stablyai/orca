import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getClaudeAccountLabel } from '@/lib/claude-account-label'
import { handleRunningClaudeSessionsAfterSwitch } from '@/lib/claude-account-switch-sessions'

export function registerClaudeAccountSwitchIpcBridge(unsubs: (() => void)[]): void {
  const api = window.api.claudeAccounts
  if (api?.onSelectedElsewhere) {
    unsubs.push(
      api.onSelectedElsewhere((change) => {
        if (change.automatic) {
          toast.info(
            translate(
              'accounts.claude.autoSwitch.switched',
              'Switched Claude to {{account}} because {{previous}} ran low on usage.',
              {
                account: getClaudeAccountLabel(change.after.state, change.after.accountId),
                previous: getClaudeAccountLabel(change.before.state, change.before.accountId)
              }
            )
          )
        }
        void handleRunningClaudeSessionsAfterSwitch({ owner: { kind: 'local' }, ...change })
      })
    )
  }
  if (api?.onAutoSwitchUnavailable) {
    unsubs.push(
      api.onAutoSwitchUnavailable((notice) => {
        toast.warning(
          translate(
            'accounts.claude.autoSwitch.unavailable',
            '{{account}} is low on Claude usage, and no other account has known usage above your minimums.',
            { account: getClaudeAccountLabel(notice.state, notice.accountId) }
          )
        )
      })
    )
  }
}
