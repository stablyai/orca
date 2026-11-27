import { useEffect, useMemo, useRef, useState } from 'react'
import { withManagedAccountDisplayNames } from '../../../../../shared/agent-accounts/managed-account-display-names'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../../shared/agent-accounts/managed-account-types'
import type { CodexConfigSyncStatus } from '../../../../../shared/agent-accounts/codex/codex-config-sync-types'
import type { RateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { useObservedAccountPlans } from './use-observed-account-plans'
import { toast } from 'sonner'
import { useAppStore } from '../../../store/index'
import { translate } from '@/i18n/i18n'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import {
  emptyClaudeAccountsState,
  emptyCodexAccountsState,
  getProviderAccountsOwnerKey,
  watchProviderAccounts
} from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import { getAccountsClaudeSearchEntries } from './accounts-claude-search'
import {
  getAccountsCodexSearchEntries,
  getAccountsCursorSearchEntries,
  getAccountsGrokSearchEntries,
  getAccountsAntigravitySearchEntries,
  getAccountsLocationSearchEntries,
  getAccountsMiniMaxSearchEntries,
  getAccountsOpencodeSearchEntries,
  getAccountsZcodePlanSearchEntries
} from './accounts-search'
import { getRemoteAccountsPaneScope } from '../../provider-accounts/provider-account-scope'
import { ProviderHostScopeControl } from '../../provider-accounts/ProviderHostScopeControl'
import { SettingsSectionStack } from '../section-layout/SettingsSectionStack'
import { matchesSettingsSearch } from '../search/settings-search'
import { getCodexAccountAuthWarning } from './codex/codex-account-auth-warning'
import { getCodexConfigSyncWarning } from './codex/codex-config-sync-warning'
import {
  getProviderAccountActiveIdForView,
  providerAccountMatchesView
} from '../../provider-accounts/provider-account-visibility'
import { GrokAccountsSection } from './providers/GrokAccountsSection'
import { AntigravityAccountsSection } from './providers/AntigravityAccountsSection'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import { CursorAccountsSection } from './providers/CursorAccountsSection'
import { ZcodePlanAccountsSection } from './usage/ZcodePlanAccountsSection'
import type {
  AccountsPaneProps,
  AccountsPaneSectionModel,
  ProviderAccountAction,
  RemoveAccountTarget,
  RenameAccountTarget
} from './accounts-pane-types'
import { AccountRenameDialog } from './account-rename-dialog'
import { EMPTY_WSL_DISTROS, getSelectedAccountRuntime } from './scope/accounts-pane-runtime'
import { getRuntimeSentenceLabel } from '../../../lib/provider-accounts/account-runtime-label'
import { watchCodexConfigSyncStatus } from '../../../runtime/provider-accounts/codex-config-sync-observer'
import { createAccountsPaneRunners } from './accounts-pane-account-actions'
import { renderAccountsLocationSection } from './scope/accounts-pane-location-section'
import { isSystemDefaultActive } from './scope/system-default-lanes'
import { renderClaudeAccountsSection } from './claude/accounts-pane-claude-section'
import { renderCodexAccountsSection } from './codex/accounts-pane-codex-section'
import { renderOpenCodeAccountsSection } from './providers/accounts-pane-opencode-section'
import { MiniMaxAccountsSection } from './usage/MiniMaxAccountsSection'
import { useUsageHostSettings } from './usage/use-usage-host-settings'
import { ManagedDataAccountsSection } from './providers/ManagedDataAccountsSection'
import { renderAccountsRemovalDialogs } from './accounts-pane-removal-dialogs'

export function AccountsPane({
  settings,
  updateSettings,
  updateSettingsOrThrow,
  hostScope,
  nativeAccounts = false,
  onAccountLocationChange,
  wslSupportedPlatform = false,
  wslAvailable = false,
  wslDistros = EMPTY_WSL_DISTROS,
  wslCapabilitiesLoading = false,
  accountOwnerPlatform = null,
  wslHostDistro = null
}: AccountsPaneProps): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
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
    nativeAccounts ? { ...settings, localAccountRuntime: 'host' } : settings,
    wslSupportedPlatform,
    wslAvailable,
    wslDistros,
    wslCapabilitiesLoading,
    wslHostDistro,
    t
  )
  const accountOwner = hostScope.target
  const isRemoteAccountScope = accountOwner.kind === 'environment'
  const scopeEnvironmentId = runtimeTargetEnvironmentId(hostScope.target)
  const accountOwnerKey = getProviderAccountsOwnerKey(accountOwner)
  const currentAccountOwnerKeyRef = useRef(accountOwnerKey)
  useEffect(() => {
    currentAccountOwnerKeyRef.current = accountOwnerKey
  }, [accountOwnerKey])
  const isCurrentAccountOwner = (): boolean => currentAccountOwnerKeyRef.current === accountOwnerKey
  const remoteServerName = isRemoteAccountScope
    ? (runtimeEnvironments.find((environment) => environment.id === scopeEnvironmentId)?.name ??
      null)
    : null
  const remoteServerLabel = isRemoteAccountScope
    ? (remoteServerName ??
      t('auto.components.settings.AccountsPane.remoteServerFallback', 'the remote server'))
    : null
  const accountRuntime = isRemoteAccountScope
    ? { runtime: 'host' as const, label: remoteServerLabel ?? '' }
    : localAccountRuntime
  const accountRuntimeSentenceLabel = isRemoteAccountScope
    ? accountRuntime.label
    : getRuntimeSentenceLabel(accountRuntime)
  const localAccountRuntimeSentenceLabel = getRuntimeSentenceLabel(localAccountRuntime)
  const remoteAccountScopeNotice =
    isRemoteAccountScope && !isWebClientLocation() ? (
      <ProviderHostScopeControl
        labelPrefix={t('auto.components.settings.AccountsPane.accountScopePrefix', 'Account scope')}
        scope={getRemoteAccountsPaneScope(remoteServerName, t)}
        className="text-xs"
      />
    ) : null
  const [ownerCodexAccounts, setCodexAccounts] =
    useState<CodexRateLimitAccountsState>(emptyCodexAccountsState)
  const [codexAccountsLoaded, setCodexAccountsLoaded] = useState(false)
  const [codexAction, setCodexAction] = useState<ProviderAccountAction>('idle')
  const [ownerClaudeAccounts, setClaudeAccounts] =
    useState<ClaudeRateLimitAccountsState>(emptyClaudeAccountsState)
  const [claudeAction, setClaudeAction] = useState<ProviderAccountAction>('idle')
  const [ownerUsage, setOwnerUsage] = useState<{
    environmentId: string
    rateLimits: RateLimitState | null
  } | null>(null)
  const claudeSectionShown = matchesSettingsSearch(searchQuery, getAccountsClaudeSearchEntries())
  const codexSectionShown = matchesSettingsSearch(searchQuery, getAccountsCodexSearchEntries())
  const { claudeAccountPlans, codexAccountPlans } = useObservedAccountPlans({
    isRemoteAccountScope,
    ownerUsage:
      scopeEnvironmentId && ownerUsage?.environmentId === scopeEnvironmentId
        ? ownerUsage.rateLimits
        : null,
    claudeShown: claudeSectionShown,
    codexShown: codexSectionShown
  })
  const localNames = isRemoteAccountScope ? undefined : settings.managedAccountDisplayNames
  const codexAccounts = useMemo(
    () => withManagedAccountDisplayNames(ownerCodexAccounts, localNames, 'codex'),
    [ownerCodexAccounts, localNames]
  )
  const claudeAccounts = useMemo(
    () => withManagedAccountDisplayNames(ownerClaudeAccounts, localNames, 'claude'),
    [ownerClaudeAccounts, localNames]
  )
  const [removeCodexTarget, setRemoveCodexTarget] = useState<RemoveAccountTarget | null>(null)
  const [removeClaudeTarget, setRemoveClaudeTarget] = useState<RemoveAccountTarget | null>(null)
  const [renameTarget, setRenameTarget] = useState<RenameAccountTarget | null>(null)
  const [renamingAccountKeys, setRenamingAccountKeys] = useState<ReadonlySet<string>>(
    () => new Set()
  )
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
  const systemCodexActive = isSystemDefaultActive(
    codexAccounts,
    visibleCodexAccounts,
    accountRuntime,
    accountVisibilityOptions
  )
  const systemClaudeActive = isSystemDefaultActive(
    claudeAccounts,
    visibleClaudeAccounts,
    accountRuntime,
    accountVisibilityOptions
  )
  const systemCodexIdentity =
    accountRuntime.runtime === 'host' ? codexAccounts.systemDefault : undefined
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
  const [codexConfigSync, setCodexConfigSync] = useState<CodexConfigSyncStatus | null>(null)
  useEffect(() => {
    if (isRemoteAccountScope || accountRuntime.runtime !== 'host') {
      setCodexConfigSync(null)
      return
    }
    return watchCodexConfigSyncStatus(setCodexConfigSync)
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
    const watcher = watchProviderAccounts(owner, {
      onSnapshot: (snapshot) => {
        if (!snapshot.failedProviders?.includes('codex')) {
          setCodexAccounts(snapshot.codex)
          setCodexAccountsLoaded(true)
        }
        if (!snapshot.failedProviders?.includes('claude')) {
          setClaudeAccounts(snapshot.claude)
        }
        if (scopeEnvironmentId) {
          setOwnerUsage({ environmentId: scopeEnvironmentId, rateLimits: snapshot.rateLimits })
        }
      },
      onClosedAfterSnapshot: () => setOwnerUsage(null),
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
  const { runCodexAccountAction, runClaudeAccountAction, renameAccount } =
    createAccountsPaneRunners({
      settings,
      accountOwner,
      hostLabel: accountRuntimeSentenceLabel,
      isCurrentAccountOwner,
      accountRuntime,
      isRemoteAccountScope,
      codexAccounts,
      setCodexAccounts,
      setCodexAccountsLoaded,
      setCodexAction,
      claudeAccounts,
      setClaudeAccounts,
      setClaudeAction,
      setRenamingAccountKeys,
      fetchSettings,
      recordFeatureInteraction
    })
  const model: AccountsPaneSectionModel = {
    settings,
    accountOwner,
    updateSettings,
    updateSettingsOrThrow,
    onAccountLocationChange,
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
    setRenameTarget,
    renameAccount,
    renamingAccountKeys,
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
    claudeAccountPlans,
    codexAccountPlans,
    setRemoveCodexTarget,
    runCodexAccountAction,
    recordOpenCodeSettingEdit
  }
  const readsOwnerGrokCursor = !isRemoteAccountScope || isWebClientLocation()
  const visibleSections = [
    wslSupportedPlatform &&
    !isRemoteAccountScope &&
    !wslHostDistro &&
    matchesSettingsSearch(searchQuery, getAccountsLocationSearchEntries())
      ? renderAccountsLocationSection(model, t)
      : null,
    claudeSectionShown ? renderClaudeAccountsSection(model, t, intlLocale) : null,
    codexSectionShown ? renderCodexAccountsSection(model, t, intlLocale) : null,
    matchesSettingsSearch(searchQuery, getAccountsAntigravitySearchEntries()) ? (
      <AntigravityAccountsSection
        key={`antigravity:${accountOwnerKey}:${accountRuntime.runtime}:${accountRuntime.wslDistro ?? ''}`}
        owner={accountOwner}
        target={{ runtime: accountRuntime.runtime, wslDistro: accountRuntime.wslDistro }}
        label={accountRuntimeSentenceLabel}
        ownerPlatform={accountOwnerPlatform}
      />
    ) : null,
    readsOwnerGrokCursor && matchesSettingsSearch(searchQuery, getAccountsGrokSearchEntries()) ? (
      <GrokAccountsSection key="grok" />
    ) : null,
    !searchQuery || /opencode|account/i.test(searchQuery) ? (
      <ManagedDataAccountsSection key={accountOwnerKey} provider="opencode" target={accountOwner} />
    ) : null,
    matchesSettingsSearch(searchQuery, getAccountsOpencodeSearchEntries())
      ? renderOpenCodeAccountsSection(model, t)
      : null,
    !searchQuery || /devin|account/i.test(searchQuery) ? (
      <ManagedDataAccountsSection
        key={`devin:${accountOwnerKey}`}
        provider="devin"
        target={accountOwner}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, getAccountsMiniMaxSearchEntries()) ? (
      <MiniMaxAccountsSection
        key={`minimax:${accountOwnerKey}`}
        host={usageCredentialHost}
        usageSettings={usageHostSettings}
        miniMaxRateLimits={isRemoteAccountScope ? null : miniMaxRateLimits}
        recordFeatureInteraction={recordFeatureInteraction}
      />
    ) : null,
    readsOwnerGrokCursor && matchesSettingsSearch(searchQuery, getAccountsCursorSearchEntries()) ? (
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
      {renderAccountsRemovalDialogs(model, removeCodexTarget, removeClaudeTarget, t)}
      <AccountRenameDialog model={model} target={renameTarget} />
      <SettingsSectionStack sections={visibleSections} />
    </div>
  )
}
