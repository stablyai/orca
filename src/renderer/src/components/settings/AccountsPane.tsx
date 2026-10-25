import { useEffect, useRef, useState } from 'react'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import type { CodexConfigSyncStatus } from '../../../../shared/codex-config-sync-types'
import { toast } from 'sonner'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
import { isWebClientLocation } from '@/lib/web-client-location'
import {
  emptyClaudeAccountsState,
  emptyCodexAccountsState,
  getProviderAccountsOwnerKey,
  watchProviderAccounts
} from '@/runtime/runtime-provider-accounts-client'
import { getAccountsClaudeSearchEntries } from './accounts-claude-search'
import {
  getAccountsCodexSearchEntries,
  getAccountsGeminiSearchEntries,
  getAccountsCursorSearchEntries,
  getAccountsGrokSearchEntries,
  getAccountsAntigravitySearchEntries,
  getAccountsLocationSearchEntries,
  getAccountsMiniMaxSearchEntries,
  getAccountsOpencodeSearchEntries,
  getAccountsPaneSearchEntries,
  getAccountsZcodePlanSearchEntries
} from './accounts-search'
import { getRemoteAccountsPaneScope } from './provider-account-scope'
import { ProviderHostScopeControl } from './ProviderHostScopeControl'
import { SettingsSectionStack } from './SettingsSectionStack'
import { matchesSettingsSearch } from './settings-search'
import { getCodexAccountAuthWarning } from './codex-account-auth-warning'
import { getCodexConfigSyncWarning } from './codex-config-sync-warning'
import {
  getProviderAccountActiveIdForView,
  providerAccountIsActiveInView,
  providerAccountMatchesView
} from './provider-account-visibility'
import { GrokAccountsSection } from './GrokAccountsSection'
import { AntigravityAccountsSection } from './AntigravityAccountsSection'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import { CursorAccountsSection } from './CursorAccountsSection'
import { ZcodePlanAccountsSection } from './ZcodePlanAccountsSection'
import type {
  AccountsPaneProps,
  AccountsPaneSectionModel,
  ClaudeAccountAction,
  CodexAccountAction,
  RemoveAccountTarget
} from './accounts-pane-types'
import {
  EMPTY_WSL_DISTROS,
  getRuntimeSentenceLabel,
  getSelectedAccountRuntime
} from './accounts-pane-runtime'
import { watchCodexConfigSyncStatus } from './accounts-pane-config-sync'
import {
  createClaudeAccountActionRunner,
  createCodexAccountActionRunner
} from './accounts-pane-account-actions'
import { renderAccountsLocationSection } from './accounts-pane-location-section'
import { renderClaudeAccountsSection } from './accounts-pane-claude-section'
import { renderCodexAccountsSection } from './accounts-pane-codex-section'
import {
  renderGeminiAccountsSection,
  renderOpenCodeAccountsSection
} from './accounts-pane-provider-setting-sections'
import { MiniMaxAccountsSection } from './MiniMaxAccountsSection'
import { useUsageHostSettings } from './use-usage-host-settings'
import { ManagedDataAccountsSection } from './ManagedDataAccountsSection'
import { renderAccountsRemovalDialogs } from './accounts-pane-removal-dialogs'

export { getAccountsPaneSearchEntries }

export function AccountsPane({
  settings,
  updateSettings,
  hostScope,
  wslSupportedPlatform = false,
  wslAvailable = false,
  wslDistros = EMPTY_WSL_DISTROS,
  wslCapabilitiesLoading = false,
  accountOwnerPlatform = null,
  wslHostDistro = null
}: AccountsPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  const codexRateLimits = useAppStore((s) => s.rateLimits.codex)
  const codexRateLimitTarget = useAppStore((s) => s.rateLimits.codexTarget)
  const miniMaxRateLimits = useAppStore((s) => s.rateLimits.minimax)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const recordedOpenCodeSettingEditsRef = useRef<Set<'cookie' | 'workspaceId' | 'apiKey'>>(
    new Set()
  )
  const localAccountRuntime = getSelectedAccountRuntime(
    settings,
    wslSupportedPlatform,
    wslAvailable,
    wslDistros,
    wslCapabilitiesLoading,
    wslHostDistro
  )
  // Route all account actions to the Settings-selected owner, independent of focused host (#7973).
  const accountOwner = hostScope.target
  const isRemoteAccountScope = accountOwner.kind === 'environment'
  const scopeEnvironmentId = runtimeTargetEnvironmentId(hostScope.target)
  // Late select/remove results belong to their original owner, not the newly shown host.
  const accountOwnerKey = getProviderAccountsOwnerKey(accountOwner)
  const currentAccountOwnerKeyRef = useRef(accountOwnerKey)
  useEffect(() => {
    currentAccountOwnerKeyRef.current = accountOwnerKey
  }, [accountOwnerKey])
  const isCurrentAccountOwner = (): boolean => currentAccountOwnerKeyRef.current === accountOwnerKey
  // Keep real names separate so scope labels cannot interpolate prose fallbacks.
  const remoteServerName = isRemoteAccountScope
    ? (runtimeEnvironments.find((environment) => environment.id === scopeEnvironmentId)?.name ??
      null)
    : null
  const remoteServerLabel = isRemoteAccountScope
    ? (remoteServerName ??
      translate('auto.components.settings.AccountsPane.remoteServerFallback', 'the remote server'))
    : null
  const accountRuntime = isRemoteAccountScope
    ? { runtime: 'host' as const, label: remoteServerLabel ?? '' }
    : localAccountRuntime
  const accountRuntimeSentenceLabel = isRemoteAccountScope
    ? accountRuntime.label
    : getRuntimeSentenceLabel(accountRuntime)
  const localAccountRuntimeSentenceLabel = getRuntimeSentenceLabel(localAccountRuntime)
  // Reassure desktop users that remote scope did not delete local accounts (#8186); web clients cannot switch back to local accounts.
  const remoteAccountScopeNotice =
    isRemoteAccountScope && !isWebClientLocation() ? (
      <ProviderHostScopeControl
        labelPrefix={translate(
          'auto.components.settings.AccountsPane.accountScopePrefix',
          'Account scope'
        )}
        scope={getRemoteAccountsPaneScope(remoteServerName)}
        className="text-xs"
      />
    ) : null

  const [codexAccounts, setCodexAccounts] =
    useState<CodexRateLimitAccountsState>(emptyCodexAccountsState)
  const [codexAccountsLoaded, setCodexAccountsLoaded] = useState(false)
  const [codexAction, setCodexAction] = useState<CodexAccountAction>('idle')
  const [claudeAccounts, setClaudeAccounts] =
    useState<ClaudeRateLimitAccountsState>(emptyClaudeAccountsState)
  const [claudeAction, setClaudeAction] = useState<ClaudeAccountAction>('idle')
  // Capture runtime slots at dialog opening; roster updates could remove the slot needed for restart diffs.
  const [removeCodexTarget, setRemoveCodexTarget] = useState<RemoveAccountTarget | null>(null)
  const [removeClaudeTarget, setRemoveClaudeTarget] = useState<RemoveAccountTarget | null>(null)
  const accountVisibilityOptions = {
    remoteOwner: isRemoteAccountScope,
    ownerPlatform: accountOwnerPlatform
  }
  const visibleClaudeAccounts = claudeAccounts.accounts.filter((account) =>
    providerAccountMatchesView(account, accountRuntime, accountVisibilityOptions)
  )
  const visibleCodexAccounts = codexAccounts.accounts.filter((account) =>
    providerAccountMatchesView(account, accountRuntime, accountVisibilityOptions)
  )
  const activeCodexAccountId = getProviderAccountActiveIdForView(codexAccounts, accountRuntime)
  // Unknown remote platforms hide WSL rows; check the full roster before marking System default active.
  const ownerPlatformUnknown = isRemoteAccountScope && accountOwnerPlatform === null
  const systemCodexActive = !(
    ownerPlatformUnknown ? codexAccounts.accounts : visibleCodexAccounts
  ).some((account) =>
    providerAccountIsActiveInView(account, codexAccounts, accountRuntime, accountVisibilityOptions)
  )
  const systemClaudeActive = !(
    ownerPlatformUnknown ? claudeAccounts.accounts : visibleClaudeAccounts
  ).some((account) =>
    providerAccountIsActiveInView(account, claudeAccounts, accountRuntime, accountVisibilityOptions)
  )
  // System identity reflects the host’s ~/.codex; per-distro WSL uses generic copy.
  const systemCodexIdentity =
    accountRuntime.runtime === 'host' ? codexAccounts.systemDefault : undefined
  // Desktop rate-limit polls cannot describe remote-owned auth warnings.
  const activeCodexAuthWarning = codexAccountsLoaded
    ? getCodexAccountAuthWarning({
        limits: isRemoteAccountScope ? null : codexRateLimits,
        target: codexRateLimitTarget,
        runtime: accountRuntime,
        activeAccountId: activeCodexAccountId,
        accountId: activeCodexAccountId,
        authKind: activeCodexAccountId === null ? systemCodexIdentity?.authKind : undefined
      })
    : null
  // An unusable ~/.codex leaves the mirror serving stale settings; surface why edits are ignored.
  const [codexConfigSync, setCodexConfigSync] = useState<CodexConfigSyncStatus | null>(null)
  useEffect(() => {
    // Sync status describes local host homes; WSL/remote scopes mirror unrelated homes.
    if (isRemoteAccountScope || accountRuntime.runtime !== 'host') {
      setCodexConfigSync(null)
      return
    }
    // Retry transient managed-home locks serially; lock release changes no effect dependency and overlapping polls could apply stale results.
    return watchCodexConfigSyncStatus(setCodexConfigSync)
    // Selection changes choose a different mirrored home; refetch rather than describe the previous account.
  }, [isRemoteAccountScope, accountRuntime.runtime, activeCodexAccountId, codexAccountsLoaded])
  const codexConfigSyncWarning = getCodexConfigSyncWarning(codexConfigSync)
  const systemCodexMissingSignIn = activeCodexAuthWarning === 'missing-sign-in'
  const systemCodexNeedsSignIn = activeCodexAccountId === null && Boolean(activeCodexAuthWarning)
  const accountRuntimeUnavailable =
    accountRuntime.runtime === 'wsl' && !wslAvailable && !wslCapabilitiesLoading

  const recordOpenCodeSettingEdit = (field: 'cookie' | 'workspaceId' | 'apiKey'): void => {
    if (recordedOpenCodeSettingEditsRef.current.has(field)) {
      return
    }
    recordedOpenCodeSettingEditsRef.current.add(field)
    recordFeatureInteraction('usage-tracking')
  }
  // Usage credentials belong beside the selected host’s poller.
  const usageCredentialHost = { owner: accountOwner, label: remoteServerLabel }
  const usageHostSettings = useUsageHostSettings(
    accountOwner,
    remoteServerLabel,
    settings,
    updateSettings
  )

  useEffect(() => {
    const owner: RuntimeClientTarget = scopeEnvironmentId
      ? { kind: 'environment', environmentId: scopeEnvironmentId }
      : { kind: 'local' }
    // Keep remote watchers open for streamed usage after the initial snapshot; local watchers resolve once.
    const watcher = watchProviderAccounts(owner, {
      onSnapshot: (snapshot) => {
        // Failed-provider rosters are substituted empty data; retain prior state and keep the loaded gate shut.
        if (!snapshot.failedProviders?.includes('codex')) {
          setCodexAccounts(snapshot.codex)
          setCodexAccountsLoaded(true)
        }
        if (!snapshot.failedProviders?.includes('claude')) {
          setClaudeAccounts(snapshot.claude)
        }
      },
      onError: (error) => {
        toast.error(
          translate(
            'auto.components.settings.AccountsPane.loadAccountsFailed',
            'Could not load provider accounts.'
          ),
          { description: String((error as Error)?.message ?? error) }
        )
      }
    })
    return () => {
      watcher.close()
    }
  }, [scopeEnvironmentId])

  const runCodexAccountAction = createCodexAccountActionRunner({
    settings,
    accountOwner,
    isCurrentAccountOwner,
    accountRuntime,
    isRemoteAccountScope,
    codexAccounts,
    setCodexAccounts,
    setCodexAccountsLoaded,
    setCodexAction,
    fetchSettings,
    recordFeatureInteraction
  })
  const runClaudeAccountAction = createClaudeAccountActionRunner({
    accountOwner,
    isCurrentAccountOwner,
    accountRuntime,
    isRemoteAccountScope,
    claudeAccounts,
    setClaudeAccounts,
    setClaudeAction,
    fetchSettings,
    recordFeatureInteraction
  })
  const model: AccountsPaneSectionModel = {
    settings,
    accountOwner,
    updateSettings,
    searchQuery,
    recordFeatureInteraction,
    wslSupportedPlatform,
    wslAvailable,
    wslDistros,
    wslCapabilitiesLoading,
    localAccountRuntime,
    localAccountRuntimeSentenceLabel,
    isRemoteAccountScope,
    remoteServerName,
    remoteAccountScopeNotice,
    accountRuntime,
    accountRuntimeSentenceLabel,
    accountRuntimeUnavailable,
    accountVisibilityOptions,
    claudeAccounts,
    claudeAction,
    visibleClaudeAccounts,
    systemClaudeActive,
    setRemoveClaudeTarget,
    runClaudeAccountAction,
    codexAccounts,
    codexAction,
    visibleCodexAccounts,
    systemCodexActive,
    systemCodexNeedsSignIn,
    systemCodexMissingSignIn,
    systemCodexIdentity,
    activeCodexAuthWarning,
    activeCodexAccountId,
    codexConfigSync,
    codexConfigSyncWarning,
    codexRateLimits,
    codexRateLimitTarget,
    setRemoveCodexTarget,
    runCodexAccountAction,
    recordOpenCodeSettingEdit
  }
  const visibleSections = [
    !searchQuery || /opencode|devin|account/i.test(searchQuery) ? (
      <div key={accountOwnerKey} className="space-y-8">
        <ManagedDataAccountsSection provider="opencode" target={accountOwner} />
        <ManagedDataAccountsSection provider="devin" target={accountOwner} />
      </div>
    ) : null,
    wslSupportedPlatform &&
    !isRemoteAccountScope &&
    !wslHostDistro &&
    matchesSettingsSearch(searchQuery, getAccountsLocationSearchEntries())
      ? renderAccountsLocationSection(model)
      : null,
    matchesSettingsSearch(searchQuery, getAccountsClaudeSearchEntries())
      ? renderClaudeAccountsSection(model)
      : null,
    matchesSettingsSearch(searchQuery, getAccountsCodexSearchEntries())
      ? renderCodexAccountsSection(model)
      : null,
    matchesSettingsSearch(searchQuery, getAccountsGeminiSearchEntries())
      ? renderGeminiAccountsSection(model)
      : null,
    matchesSettingsSearch(searchQuery, getAccountsAntigravitySearchEntries()) ? (
      <AntigravityAccountsSection
        key={`antigravity:${accountOwnerKey}:${accountRuntime.runtime}:${accountRuntime.wslDistro ?? ''}`}
        owner={accountOwner}
        target={{ runtime: accountRuntime.runtime, wslDistro: accountRuntime.wslDistro }}
        label={accountRuntimeSentenceLabel}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, getAccountsOpencodeSearchEntries())
      ? renderOpenCodeAccountsSection(model)
      : null,
    matchesSettingsSearch(searchQuery, getAccountsMiniMaxSearchEntries()) ? (
      <MiniMaxAccountsSection
        key={`minimax:${accountOwnerKey}`}
        host={usageCredentialHost}
        usageSettings={usageHostSettings}
        miniMaxRateLimits={isRemoteAccountScope ? null : miniMaxRateLimits}
        recordFeatureInteraction={recordFeatureInteraction}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, getAccountsGrokSearchEntries()) ? (
      <GrokAccountsSection key="grok" />
    ) : null,
    matchesSettingsSearch(searchQuery, getAccountsCursorSearchEntries()) ? (
      <CursorAccountsSection key="cursor" />
    ) : null,
    matchesSettingsSearch(searchQuery, getAccountsZcodePlanSearchEntries()) ? (
      <ZcodePlanAccountsSection
        key={`zcode:${accountOwnerKey}`}
        host={usageCredentialHost}
        usageSettings={usageHostSettings}
      />
    ) : null
  ]

  return (
    <div className="space-y-8">
      {renderAccountsRemovalDialogs(model, removeCodexTarget, removeClaudeTarget)}
      <SettingsSectionStack sections={visibleSections} spacing="group" />
    </div>
  )
}
