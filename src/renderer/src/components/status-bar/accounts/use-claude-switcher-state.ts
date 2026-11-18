import { useAppStore } from '../../../store/index'
import type { ChatAccountAction } from './ProviderAccountChatButton'
import {
  getClaudeAccountSettings,
  getClaudeAccountRosterSyncKey,
  getClaudeAccountSyncKey
} from './provider-account-sync-key'

const EMPTY_INACTIVE: [] = []

export function useClaudeSwitcherState(
  chatAction: ChatAccountAction | undefined,
  activeRuntimeEnvironmentId: string | null
) {
  const hasActiveRuntimeEnvironment = activeRuntimeEnvironmentId !== null
  // Why local chats only: the status bar passes its owner snapshot, and a remote chat's readings live on its host.
  const chatInactiveClaudeAccounts = useAppStore((s) =>
    chatAction?.target.kind === 'local' ? s.rateLimits.inactiveClaudeAccounts : EMPTY_INACTIVE
  )
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
    chatInactiveClaudeAccounts,
    settings,
    ownHostName,
    accountSettings,
    claudeAccountSyncKey
  }
}
