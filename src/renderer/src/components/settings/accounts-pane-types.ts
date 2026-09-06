import type { Dispatch, ReactNode, SetStateAction } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import type {
  ProviderRateLimits,
  RateLimitRuntimeTarget
} from '../../../../shared/rate-limit-types'
import type { CodexConfigSyncStatus } from '../../../../shared/codex-config-sync-types'
import type { FeatureInteractionId } from '../../../../shared/feature-interaction-catalog'
import type { ProviderAccountRuntimeView } from './provider-account-visibility'

export type AccountsPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  wslSupportedPlatform?: boolean
  wslAvailable?: boolean
  wslDistros?: string[]
  wslCapabilitiesLoading?: boolean
  accountOwnerPlatform?: NodeJS.Platform | null
}

export type LocalAccountRuntime = {
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
  label: string
}

export type CodexAccountAction =
  | 'idle'
  | 'adding'
  | `reauth:${string}`
  | `remove:${string}`
  | `select:${string}`

export type ClaudeAccountAction = CodexAccountAction

export type RemoveAccountTarget = {
  id: string
  runtime: ProviderAccountRuntimeView
}

export type ProviderAccountVisibilityOptions = {
  remoteOwner: boolean
  ownerPlatform: NodeJS.Platform | null
}

export type CodexAccountActionRunner = (
  action: CodexAccountAction,
  operation: () => Promise<CodexRateLimitAccountsState>,
  actionRuntime?: ProviderAccountRuntimeView
) => Promise<void>

export type ClaudeAccountActionRunner = (
  action: ClaudeAccountAction,
  operation: () => Promise<ClaudeRateLimitAccountsState>,
  actionRuntime?: ProviderAccountRuntimeView
) => Promise<void>

export type AccountsPaneSectionModel = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  searchQuery: string
  recordFeatureInteraction: (featureId: FeatureInteractionId) => void
  wslSupportedPlatform: boolean
  wslAvailable: boolean
  wslDistros: string[]
  wslCapabilitiesLoading: boolean
  localAccountRuntime: LocalAccountRuntime
  localAccountRuntimeSentenceLabel: string
  isRemoteAccountScope: boolean
  remoteServerName: string | null
  remoteAccountScopeNotice: ReactNode
  accountRuntime: LocalAccountRuntime
  accountRuntimeSentenceLabel: string
  accountRuntimeUnavailable: boolean
  accountVisibilityOptions: ProviderAccountVisibilityOptions
  claudeAccounts: ClaudeRateLimitAccountsState
  claudeAction: ClaudeAccountAction
  visibleClaudeAccounts: ClaudeRateLimitAccountsState['accounts']
  systemClaudeActive: boolean
  setRemoveClaudeTarget: Dispatch<SetStateAction<RemoveAccountTarget | null>>
  runClaudeAccountAction: ClaudeAccountActionRunner
  codexAccounts: CodexRateLimitAccountsState
  codexAction: CodexAccountAction
  visibleCodexAccounts: CodexRateLimitAccountsState['accounts']
  systemCodexActive: boolean
  systemCodexNeedsSignIn: boolean
  systemCodexMissingSignIn: boolean
  systemCodexIdentity: CodexRateLimitAccountsState['systemDefault']
  activeCodexAuthWarning: 'missing-sign-in' | 'stale-sign-in' | null
  activeCodexAccountId: string | null
  codexConfigSync: CodexConfigSyncStatus | null
  codexConfigSyncWarning:
    | 'managed-home-unavailable'
    | 'missing-source'
    | 'blank-source'
    | 'unreadable-source'
    | null
  codexRateLimits: ProviderRateLimits | null
  codexRateLimitTarget: RateLimitRuntimeTarget
  setRemoveCodexTarget: Dispatch<SetStateAction<RemoveAccountTarget | null>>
  runCodexAccountAction: CodexAccountActionRunner
  recordOpenCodeSettingEdit: (field: 'cookie' | 'workspaceId') => void
  miniMaxRateLimits: ProviderRateLimits | null
  miniMaxCookieDraft: string
  setMiniMaxCookieDraft: Dispatch<SetStateAction<string>>
  miniMaxConfigured: boolean
  miniMaxCredentialBusy: boolean
  saveMiniMaxCookie: () => Promise<void>
  clearMiniMaxCookie: () => Promise<void>
}
