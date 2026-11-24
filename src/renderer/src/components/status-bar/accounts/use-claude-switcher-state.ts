import { useAppStore } from '../../../store/index'
import type { ChatAccountAction } from './ProviderAccountChatButton'
import {
  getClaudeAccountSettings,
  getClaudeAccountRosterSyncKey,
  getClaudeAccountSyncKey
} from './provider-account-sync-key'

export function useClaudeSwitcherState(
  chatAction: ChatAccountAction | undefined,
  activeRuntimeEnvironmentId: string | null
) {
  const hasActiveRuntimeEnvironment = activeRuntimeEnvironmentId !== null
  const settings = useAppStore((s) => (chatAction ? null : s.settings))
  const ownHostName = useAppStore(
    (s) =>
      s.runtimeEnvironments.find((environment) => environment.id === activeRuntimeEnvironmentId)
        ?.name
  )
  const accountSettings = useAppStore((s) =>
    hasActiveRuntimeEnvironment ? null : getClaudeAccountSettings(s.settings)
  )
  const claudeAccountSyncKey = useAppStore((s) =>
    chatAction
      ? hasActiveRuntimeEnvironment
        ? ''
        : getClaudeAccountRosterSyncKey(s.settings)
      : getClaudeAccountSyncKey(s.settings)
  )
  return {
    settings,
    ownHostName,
    accountSettings,
    claudeAccountSyncKey
  }
}
