import { handleRunningClaudeSessionsAfterSwitch } from '@/lib/claude-account-switch-sessions'

export function registerClaudeAccountSwitchIpcBridge(unsubs: (() => void)[]): void {
  const subscribe = window.api.claudeAccounts?.onSelectedElsewhere
  if (!subscribe) {
    return
  }
  unsubs.push(
    subscribe((change) => {
      void handleRunningClaudeSessionsAfterSwitch({ owner: { kind: 'local' }, ...change })
    })
  )
}
