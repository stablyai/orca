import { handleRunningAntigravityTerminalsAfterSwitch } from './antigravity-account-switch-sessions'

export function registerAntigravityAccountSwitchIpcBridge(unsubs: (() => void)[]): void {
  const subscribe = window.api.antigravityAccounts?.onSelectedElsewhere
  if (!subscribe) {
    return
  }
  unsubs.push(
    subscribe((change) => void handleRunningAntigravityTerminalsAfterSwitch(change, true))
  )
}
