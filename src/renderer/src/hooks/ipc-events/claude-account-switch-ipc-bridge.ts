import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getClaudeAccountLabel } from '@/lib/provider-accounts/claude-account-label'
import { handleRunningClaudeSessionsAfterSwitch } from '@/lib/provider-accounts/claude-account-switch-sessions'

export function registerClaudeAccountSwitchIpcBridge(unsubs: (() => void)[]): void {
  const subscribe = window.api.claudeAccounts?.onSelectedElsewhere
  if (!subscribe) {
    return
  }
  unsubs.push(
    subscribe(({ reason, ...change }) => {
      if (reason === 'usage-limit') {
        // Why: nobody chose this switch, so say which account ran out and where Orca went.
        toast.info(
          translate(
            'accounts.claude.usageLimitSwitch.switched',
            'Switched to {{next}}: {{previous}} reached its usage limit',
            {
              next: getClaudeAccountLabel(change.after.state, change.after.accountId),
              previous: getClaudeAccountLabel(change.before.state, change.before.accountId)
            }
          )
        )
      }
      void handleRunningClaudeSessionsAfterSwitch({
        owner: { kind: 'local' },
        ...change,
        madeElsewhere: true
      })
    })
  )
}
