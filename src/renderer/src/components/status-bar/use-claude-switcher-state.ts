import { useAppStore } from '../../store'
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
  const inactiveClaudeAccounts = useAppStore((s) =>
    chatAction?.target.kind === 'environment' ? EMPTY_INACTIVE : s.rateLimits.inactiveClaudeAccounts
  )
  const claudeTarget = useAppStore((s) => (chatAction ? undefined : s.rateLimits.claudeTarget))
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
    inactiveClaudeAccounts,
    claudeTarget,
    settings,
    ownHostName,
    accountSettings,
    claudeAccountSyncKey
  }
}
