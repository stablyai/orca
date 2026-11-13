import type { Dispatch, ReactNode, SetStateAction } from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../../shared/managed-account-types'
import type {
  ProviderRateLimits,
  RateLimitRuntimeTarget
} from '../../../../../shared/rate-limit-types'
import type { CodexConfigSyncStatus } from '../../../../../shared/codex-config-sync-types'
import type { FeatureInteractionId } from '../../../../../shared/feature-interaction-catalog'
import type { ProviderAccountRuntimeView } from '../../provider-accounts/provider-account-visibility'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { SettingsHostScope } from '../host-scope/settings-host-scope'
import type { LocalAccountRuntime } from '../../../lib/provider-accounts/account-runtime-label'

export type AccountsPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void> | void
  updateSettingsOrThrow: (updates: Partial<GlobalSettings>) => Promise<void> | void
  hostScope: SettingsHostScope
  nativeAccounts?: boolean
  onAccountLocationChange?: () => void
  wslSupportedPlatform?: boolean
  wslAvailable?: boolean
  wslDistros?: string[]
  wslCapabilitiesLoading?: boolean
  accountOwnerPlatform?: NodeJS.Platform | null
  /** Set when the chosen host is a WSL host: this desktop owns that distro's accounts. */
  wslHostDistro?: string | null
}

export type ProviderAccountAction =
  | 'idle'
  | 'adding'
  | `reauth:${string}`
  | `remove:${string}`
  | `select:${string}`

export type RemoveAccountTarget = {
  id: string
  runtime: ProviderAccountRuntimeView
}

export type RenameAccountTarget = {
  provider: 'claude' | 'codex'
  id: string
  email: string
  displayName: string | null
  runtime: ProviderAccountRuntimeView
}

export type ProviderAccountVisibilityOptions = {
  remoteOwner: boolean
  ownerPlatform: NodeJS.Platform | null
}

export type CodexAccountActionRunner = (
  action: ProviderAccountAction,
  operation: () => Promise<CodexRateLimitAccountsState>,
  actionRuntime?: ProviderAccountRuntimeView
) => Promise<void>

export type ClaudeAccountActionRunner = (
  action: ProviderAccountAction,
  operation: () => Promise<ClaudeRateLimitAccountsState>,
  actionRuntime?: ProviderAccountRuntimeView
) => Promise<void>

export type AccountsPaneSectionModel = {
  settings: GlobalSettings
  /** Host whose accounts the pane lists and mutates. */
  accountOwner: RuntimeClientTarget
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void> | void
  updateSettingsOrThrow: (updates: Partial<GlobalSettings>) => Promise<void> | void
  onAccountLocationChange?: () => void
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
  claudeAction: ProviderAccountAction
  visibleClaudeAccounts: ClaudeRateLimitAccountsState['accounts']
  systemClaudeActive: boolean
  setRemoveClaudeTarget: Dispatch<SetStateAction<RemoveAccountTarget | null>>
  setRenameTarget: Dispatch<SetStateAction<RenameAccountTarget | null>>
  renameAccount: (target: RenameAccountTarget, displayName: string) => Promise<void>
  /** `provider:id` of accounts with a rename in flight. */
  renamingAccountKeys: ReadonlySet<string>
  runClaudeAccountAction: ClaudeAccountActionRunner
  codexAccounts: CodexRateLimitAccountsState
  codexAction: ProviderAccountAction
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
  recordOpenCodeSettingEdit: (field: 'cookie' | 'workspaceId' | 'apiKey') => void
}
