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
  hasRemoteProviderAccountOwner,
  watchProviderAccounts
} from '@/runtime/runtime-provider-accounts-client'
import {
  getAccountsClaudeSearchEntries,
  getAccountsCodexSearchEntries,
  getAccountsGeminiSearchEntries,
  getAccountsGrokSearchEntries,
  getAccountsLocationSearchEntries,
  getAccountsMiniMaxSearchEntries,
  getAccountsOpencodeSearchEntries,
  getAccountsPaneSearchEntries
} from './accounts-search'
import { getRemoteAccountsPaneScope } from './provider-account-scope'
import { ProviderHostScopeControl } from './ProviderHostScopeControl'
import { matchesSettingsSearch } from './settings-search'
import { getCodexAccountAuthWarning } from './codex-account-auth-warning'
import { getCodexConfigSyncWarning } from './codex-config-sync-warning'
import {
  getProviderAccountActiveIdForView,
  providerAccountIsActiveInView,
  providerAccountMatchesView
} from './provider-account-visibility'
import { Separator } from '../ui/separator'
import { GrokAccountsSection } from './GrokAccountsSection'
import type {
  AccountsPaneProps,
  AccountsPaneSectionModel,
  ClaudeAccountAction,
  CodexAccountAction,
  RemoveAccountTarget
} from './accounts-pane-types'
import { EMPTY_WSL_DISTROS, getSelectedAccountRuntime } from './accounts-pane-runtime'
import { watchCodexConfigSyncStatus } from './accounts-pane-config-sync'
import {
  createClaudeAccountActionRunner,
  createCodexAccountActionRunner
} from './accounts-pane-account-actions'
import { createMiniMaxCredentialActions } from './accounts-pane-minimax-actions'
import { renderAccountsLocationSection } from './accounts-pane-location-section'
import { renderClaudeAccountsSection } from './accounts-pane-claude-section'
import { renderCodexAccountsSection } from './accounts-pane-codex-section'
import {
  renderGeminiAccountsSection,
  renderOpenCodeAccountsSection
} from './accounts-pane-provider-setting-sections'
import { renderMiniMaxAccountsSection } from './accounts-pane-minimax-section'
import { renderAccountsRemovalDialogs } from './accounts-pane-removal-dialogs'

export { getAccountsPaneSearchEntries }

export function AccountsPane({
  settings,
  updateSettings,
  wslSupportedPlatform = false,
  wslAvailable = false,
  wslDistros = EMPTY_WSL_DISTROS,
  wslCapabilitiesLoading = false,
  accountOwnerPlatform = null
}: AccountsPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  const codexRateLimits = useAppStore((s) => s.rateLimits.codex)
  const codexRateLimitTarget = useAppStore((s) => s.rateLimits.codexTarget)
  const miniMaxRateLimits = useAppStore((s) => s.rateLimits.minimax)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const recordedOpenCodeSettingEditsRef = useRef<Set<'cookie' | 'workspaceId'>>(new Set())
  const [miniMaxCookieDraft, setMiniMaxCookieDraft] = useState('')
  const [miniMaxConfigured, setMiniMaxConfigured] = useState(false)
  const [miniMaxCredentialBusy, setMiniMaxCredentialBusy] = useState(false)
  const localAccountRuntime = getSelectedAccountRuntime(
    settings,
    wslSupportedPlatform,
    wslAvailable,
    wslDistros,
    wslCapabilitiesLoading
  )
  // Why: with a Remote Orca Server active the server owns provider accounts
  // (see #7973); every list/select/remove below must scope to it, not host/WSL.
  const isRemoteAccountScope = hasRemoteProviderAccountOwner(settings)
  const activeRuntimeEnvironmentId = settings.activeRuntimeEnvironmentId?.trim() || null
  // Why: keep the real name separate from the prose fallback below; the scope
  // label must not interpolate the fallback.
  const remoteServerName = isRemoteAccountScope
    ? (runtimeEnvironments.find((environment) => environment.id === activeRuntimeEnvironmentId)
        ?.name ?? null)
    : null
  const remoteServerLabel = isRemoteAccountScope
    ? (remoteServerName ??
      translate('auto.components.settings.AccountsPane.remoteServerFallback', 'the remote server'))
    : null
  const accountRuntime = isRemoteAccountScope
    ? { runtime: 'host' as const, label: remoteServerLabel ?? '' }
    : localAccountRuntime
  // Why: host runtime labels are standalone UI labels; interpolated prose needs sentence casing.
  const accountRuntimeSentenceLabel =
    !isRemoteAccountScope &&
    accountRuntime.runtime === 'host' &&
    !navigator.userAgent.includes('Windows')
      ? `${accountRuntime.label.charAt(0).toLocaleLowerCase()}${accountRuntime.label.slice(1)}`
      : accountRuntime.label
  const localAccountRuntimeSentenceLabel =
    localAccountRuntime.runtime === 'host' && !navigator.userAgent.includes('Windows')
      ? `${localAccountRuntime.label.charAt(0).toLocaleLowerCase()}${localAccountRuntime.label.slice(1)}`
      : localAccountRuntime.label
  // Why: users read the remote-scoped list as their desktop accounts being
  // deleted (#8186); say they are intact and link the default-runtime control.
  // The web client has no desktop-owned accounts and cannot select Local
  // desktop, so promising a switch back would be a dead end there.
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
  // Why: capture the account's runtime slot when the dialog opens; the roster
  // can change underneath an open dialog and lose the slot to diff for restarts.
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
  // Why: System default lights only when no account row is active; while a remote
  // owner's platform is unknown WSL rows hide fail-closed, so check the full roster.
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
  // Why: the system default's real identity is host-scoped (it reflects the
  // runtime's own ~/.codex), so only surface it in the host view. Per-distro
  // WSL falls back to the generic label.
  const systemCodexIdentity =
    accountRuntime.runtime === 'host' ? codexAccounts.systemDefault : undefined
  // Why: remote snapshots own their system-default identity, but the desktop's
  // rate-limit poll must not be misattributed to a remote account owner.
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
  // Why: the mirror keeps serving the last synced settings when ~/.codex is
  // unusable, so without this the user only sees their edits being ignored.
  const [codexConfigSync, setCodexConfigSync] = useState<CodexConfigSyncStatus | null>(null)
  useEffect(() => {
    // Why: the status resolves the host's own ~/.codex and shared runtime home.
    // A WSL or remote scope mirrors different homes entirely, so showing it there
    // would name a config file that has nothing to do with the selected runtime.
    if (isRemoteAccountScope || accountRuntime.runtime !== 'host') {
      setCodexConfigSync(null)
      return
    }
    // Why: a temporarily locked managed home clears on its own, but this effect
    // only reruns on scope/runtime/selection changes — none of which a lock
    // release triggers. Without a retry the warning would stick until remount.
    // Serialized (timeout, not interval) so a slow response can never be
    // overwritten by an older one.
    return watchCodexConfigSyncStatus(setCodexConfigSync)
    // Why: the status resolves whichever home the ACTIVE selection mirrors into
    // (per-account, shared, or none for the real-home lane), so switching
    // accounts must refetch or the banner describes the previous account.
  }, [isRemoteAccountScope, accountRuntime.runtime, activeCodexAccountId, codexAccountsLoaded])
  const codexConfigSyncWarning = getCodexConfigSyncWarning(codexConfigSync)
  const systemCodexMissingSignIn = activeCodexAuthWarning === 'missing-sign-in'
  const systemCodexNeedsSignIn = activeCodexAccountId === null && Boolean(activeCodexAuthWarning)
  const accountRuntimeUnavailable =
    accountRuntime.runtime === 'wsl' && !wslAvailable && !wslCapabilitiesLoading

  const recordOpenCodeSettingEdit = (field: 'cookie' | 'workspaceId'): void => {
    if (recordedOpenCodeSettingEditsRef.current.has(field)) {
      return
    }
    recordedOpenCodeSettingEditsRef.current.add(field)
    recordFeatureInteraction('usage-tracking')
  }
  const refreshMiniMaxCredentialStatus = async (): Promise<void> => {
    try {
      const status = await window.api.minimaxCredentials.getStatus()
      setMiniMaxConfigured(status.configured)
    } catch (error) {
      console.error('Failed to load MiniMax credential status:', error)
    }
  }
  const { saveMiniMaxCookie, clearMiniMaxCookie } = createMiniMaxCredentialActions({
    miniMaxCookieDraft,
    setMiniMaxCookieDraft,
    setMiniMaxConfigured,
    setMiniMaxCredentialBusy,
    recordFeatureInteraction
  })

  useEffect(() => {
    void refreshMiniMaxCredentialStatus()
  }, [])

  useEffect(() => {
    // Why: remote snapshots stream usage refreshes after the synchronous ready
    // message, so the watcher stays open for the pane's lifetime; the local
    // path resolves once and the close() is a no-op.
    const watcher = watchProviderAccounts(
      { activeRuntimeEnvironmentId },
      {
        onSnapshot: (snapshot) => {
          // Why: a failed provider's half is a substituted empty roster, not
          // authoritative data; keep prior state and leave the loaded gate shut.
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
      }
    )
    return () => {
      watcher.close()
    }
  }, [activeRuntimeEnvironmentId])

  const runCodexAccountAction = createCodexAccountActionRunner({
    settings,
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
    settings,
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
    recordOpenCodeSettingEdit,
    miniMaxRateLimits,
    miniMaxCookieDraft,
    setMiniMaxCookieDraft,
    miniMaxConfigured,
    miniMaxCredentialBusy,
    saveMiniMaxCookie,
    clearMiniMaxCookie
  }
  const visibleSections = [
    wslSupportedPlatform &&
    !isRemoteAccountScope &&
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
    matchesSettingsSearch(searchQuery, getAccountsOpencodeSearchEntries())
      ? renderOpenCodeAccountsSection(model)
      : null,
    matchesSettingsSearch(searchQuery, getAccountsMiniMaxSearchEntries())
      ? renderMiniMaxAccountsSection(model)
      : null,
    matchesSettingsSearch(searchQuery, getAccountsGrokSearchEntries()) ? (
      <GrokAccountsSection key="grok" />
    ) : null
  ].filter(Boolean)

  return (
    <div className="space-y-8">
      {renderAccountsRemovalDialogs(model, removeCodexTarget, removeClaudeTarget)}
      {visibleSections.map((section, index) => (
        <div key={index} className="space-y-8">
          {index > 0 ? <Separator /> : null}
          {section}
        </div>
      ))}
    </div>
  )
}
