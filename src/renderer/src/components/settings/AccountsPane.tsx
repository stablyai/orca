/* eslint-disable max-lines -- Why: AccountsPane owns all per-provider account UI
   (Claude, Codex, Gemini, OpenCode Go, and future providers). Each provider's
   add/select/reauth/remove flow is tightly coupled to the provider-specific
   error handling and restart prompts below; splitting them into separate files
   would scatter those flows without a meaningful abstraction boundary. */
import { useEffect, useRef, useState } from 'react'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState,
  GlobalSettings
} from '../../../../shared/types'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { AlertTriangle, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useAppStore } from '../../store'
import { ClaudeIcon, GeminiIcon, OpenAIIcon, OpenCodeGoIcon } from '../status-bar/icons'
import { toast } from 'sonner'
import {
  ACCOUNTS_CLAUDE_SEARCH_ENTRIES,
  ACCOUNTS_CODEX_SEARCH_ENTRIES,
  ACCOUNTS_GEMINI_SEARCH_ENTRIES,
  ACCOUNTS_LOCATION_SEARCH_ENTRIES,
  ACCOUNTS_OPENCODE_SEARCH_ENTRIES,
  ACCOUNTS_PANE_SEARCH_ENTRIES
} from './accounts-search'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'
import { matchesSettingsSearch } from './settings-search'
import { markLiveCodexSessionsForRestart } from '@/lib/codex-session-restart'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { getCodexAccountAuthWarning } from './codex-account-auth-warning'

export { ACCOUNTS_PANE_SEARCH_ENTRIES }

type AccountsPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  wslAvailable?: boolean
  wslDistros?: string[]
  wslCapabilitiesLoading?: boolean
}

function getHostRuntimeLabel(): string {
  return navigator.userAgent.includes('Windows') ? 'Windows' : 'This device'
}

function getCodexAccountLabel(
  state: CodexRateLimitAccountsState,
  accountId: string | null | undefined
): string {
  if (accountId == null) {
    return 'System default'
  }
  return state.accounts.find((account) => account.id === accountId)?.email ?? 'Codex account'
}

function getActiveCodexAccountIdForRuntime(
  state: CodexRateLimitAccountsState,
  runtime: LocalAccountRuntime
): string | null {
  if (runtime.runtime === 'host') {
    return state.activeAccountIdsByRuntime?.host ?? state.activeAccountId
  }
  if (runtime.wslDistro) {
    return state.activeAccountIdsByRuntime?.wsl?.[runtime.wslDistro] ?? null
  }
  const defaultSelection = state.activeAccountIdsByRuntime?.wsl?.__default__
  if (defaultSelection) {
    return defaultSelection
  }
  const selectedIds = Array.from(
    new Set(Object.values(state.activeAccountIdsByRuntime?.wsl ?? {}).filter(Boolean))
  )
  return selectedIds.length === 1 ? selectedIds[0] : null
}

function getActiveClaudeAccountIdForRuntime(
  state: ClaudeRateLimitAccountsState,
  runtime: LocalAccountRuntime
): string | null {
  if (runtime.runtime === 'host') {
    return state.activeAccountIdsByRuntime?.host ?? state.activeAccountId
  }
  if (runtime.wslDistro) {
    return state.activeAccountIdsByRuntime?.wsl?.[runtime.wslDistro] ?? null
  }
  const defaultSelection = state.activeAccountIdsByRuntime?.wsl?.__default__
  if (defaultSelection) {
    return defaultSelection
  }
  const selectedIds = Array.from(
    new Set(Object.values(state.activeAccountIdsByRuntime?.wsl ?? {}).filter(Boolean))
  )
  return selectedIds.length === 1 ? selectedIds[0] : null
}

function getClaudeAccountLabel(
  state: ClaudeRateLimitAccountsState,
  accountId: string | null | undefined
): string {
  if (accountId == null) {
    return 'System default'
  }
  return state.accounts.find((account) => account.id === accountId)?.email ?? 'Claude account'
}

function getCodexAccountRuntimeLabel(
  account: CodexRateLimitAccountsState['accounts'][number]
): string {
  if (account.managedHomeRuntime === 'wsl') {
    return account.wslDistro ? `WSL ${account.wslDistro}` : 'WSL'
  }
  return getHostRuntimeLabel()
}

function getClaudeAccountRuntimeLabel(
  account: ClaudeRateLimitAccountsState['accounts'][number]
): string {
  if (account.managedAuthRuntime === 'wsl') {
    return account.wslDistro ? `WSL ${account.wslDistro}` : 'WSL'
  }
  return getHostRuntimeLabel()
}

function getCodexAccountErrorDescription(error: unknown): string {
  const message = String((error as Error)?.message ?? error)
    .replace(/^Error occurred in handler for 'codexAccounts:[^']+':\s*/i, '')
    .replace(/^Error invoking remote method 'codexAccounts:[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
  const normalizedMessage = message.toLowerCase()

  // Why: Codex account actions cross the Electron IPC boundary, and invoke()
  // failures often include transport-level wrapper text that is useful in
  // devtools but noisy in product UI. Normalize the handful of expected auth
  // failures here so users see actionable sign-in guidance instead of IPC
  // internals or raw upstream wording.
  if (normalizedMessage.includes('timed out waiting for codex login to finish')) {
    return 'Codex sign-in took too long to finish. Please try again.'
  }
  if (normalizedMessage.includes('codex sign-in took too long to finish')) {
    return 'Codex sign-in took too long to finish. Please try again.'
  }
  if (
    normalizedMessage.includes('auth error 502') ||
    normalizedMessage.includes('gateway') ||
    normalizedMessage.includes('bad gateway')
  ) {
    return 'Codex sign-in is temporarily unavailable. Please try again in a minute.'
  }
  if (normalizedMessage.startsWith('codex login failed:')) {
    const loginMessage = message.slice('Codex login failed:'.length).trim()
    return loginMessage || 'Codex sign-in failed. Please try again.'
  }

  return message || 'Codex sign-in failed. Please try again.'
}

function getClaudeAccountErrorDescription(error: unknown): string {
  return (
    String((error as Error)?.message ?? error)
      .replace(/^Error occurred in handler for 'claudeAccounts:[^']+':\s*/i, '')
      .replace(/^Error invoking remote method 'claudeAccounts:[^']+':\s*/i, '')
      .replace(/^Error:\s*/i, '')
      .trim() || 'Claude sign-in failed. Please try again.'
  )
}

type LocalAccountRuntime = {
  runtime: 'host' | 'wsl'
  wslDistro?: string | null
  label: string
}

function accountMatchesRuntime(
  account:
    | CodexRateLimitAccountsState['accounts'][number]
    | ClaudeRateLimitAccountsState['accounts'][number],
  runtime: LocalAccountRuntime
): boolean {
  const accountRuntime =
    'authMethod' in account
      ? (account.managedAuthRuntime ?? 'host')
      : (account.managedHomeRuntime ?? 'host')
  const accountDistro = account.wslDistro ?? null
  if (runtime.runtime === 'host') {
    return accountRuntime !== 'wsl'
  }
  if (accountRuntime !== 'wsl') {
    return false
  }
  return runtime.wslDistro ? accountDistro === runtime.wslDistro : true
}

function getSelectedAccountRuntime(
  settings: GlobalSettings,
  wslAvailable: boolean,
  wslDistros: string[],
  wslCapabilitiesLoading: boolean
): LocalAccountRuntime {
  if (settings.localAccountRuntime === 'wsl') {
    if (!wslAvailable && !wslCapabilitiesLoading) {
      return { runtime: 'wsl', label: 'WSL' }
    }
    const configuredDistro = settings.localAccountWslDistro?.trim() || null
    const selectedDistro =
      configuredDistro && (wslCapabilitiesLoading || wslDistros.includes(configuredDistro))
        ? configuredDistro
        : null
    return {
      runtime: 'wsl',
      wslDistro: selectedDistro,
      label: selectedDistro ? `WSL ${selectedDistro}` : 'WSL default'
    }
  }
  return { runtime: 'host', label: getHostRuntimeLabel() }
}

export function AccountsPane({
  settings,
  updateSettings,
  wslAvailable = false,
  wslDistros = [],
  wslCapabilitiesLoading = false
}: AccountsPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  const codexRateLimits = useAppStore((s) => s.rateLimits.codex)
  const codexRateLimitTarget = useAppStore((s) => s.rateLimits.codexTarget)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const recordedOpenCodeSettingEditsRef = useRef<Set<'cookie' | 'workspaceId'>>(new Set())
  const accountRuntime = getSelectedAccountRuntime(
    settings,
    wslAvailable,
    wslDistros,
    wslCapabilitiesLoading
  )

  const [codexAccounts, setCodexAccounts] = useState<CodexRateLimitAccountsState>({
    accounts: [],
    activeAccountId: null,
    activeAccountIdsByRuntime: { host: null, wsl: {} }
  })
  const [codexAccountsLoaded, setCodexAccountsLoaded] = useState(false)
  const [codexAction, setCodexAction] = useState<
    'idle' | 'adding' | `reauth:${string}` | `remove:${string}` | `select:${string | 'system'}`
  >('idle')
  const [claudeAccounts, setClaudeAccounts] = useState<ClaudeRateLimitAccountsState>({
    accounts: [],
    activeAccountId: null,
    activeAccountIdsByRuntime: { host: null, wsl: {} }
  })
  const [claudeAction, setClaudeAction] = useState<
    'idle' | 'adding' | `reauth:${string}` | `remove:${string}` | `select:${string | 'system'}`
  >('idle')
  const [removeAccountId, setRemoveAccountId] = useState<string | null>(null)
  const [removeClaudeAccountId, setRemoveClaudeAccountId] = useState<string | null>(null)
  const visibleClaudeAccounts = claudeAccounts.accounts.filter((account) =>
    accountMatchesRuntime(account, accountRuntime)
  )
  const visibleCodexAccounts = codexAccounts.accounts.filter((account) =>
    accountMatchesRuntime(account, accountRuntime)
  )
  const activeCodexAccountId = getActiveCodexAccountIdForRuntime(codexAccounts, accountRuntime)
  const activeClaudeAccountId = getActiveClaudeAccountIdForRuntime(claudeAccounts, accountRuntime)
  const activeCodexAuthWarning = codexAccountsLoaded
    ? getCodexAccountAuthWarning({
        limits: codexRateLimits,
        target: codexRateLimitTarget,
        runtime: accountRuntime,
        activeAccountId: activeCodexAccountId,
        accountId: activeCodexAccountId
      })
    : null
  const systemCodexNeedsReauthentication =
    activeCodexAccountId === null && Boolean(activeCodexAuthWarning)
  const accountRuntimeUnavailable =
    accountRuntime.runtime === 'wsl' && !wslAvailable && !wslCapabilitiesLoading

  const recordOpenCodeSettingEdit = (field: 'cookie' | 'workspaceId'): void => {
    if (recordedOpenCodeSettingEditsRef.current.has(field)) {
      return
    }
    recordedOpenCodeSettingEditsRef.current.add(field)
    recordFeatureInteraction('usage-tracking')
  }

  useEffect(() => {
    let stale = false

    const loadCodexAccounts = async (): Promise<void> => {
      try {
        const nextCodex = await window.api.codexAccounts.list()
        if (!stale) {
          setCodexAccounts(nextCodex)
          setCodexAccountsLoaded(true)
        }
      } catch (error) {
        if (!stale) {
          toast.error('Could not load Codex accounts.', {
            description: String((error as Error)?.message ?? error)
          })
        }
      }
    }

    const loadClaudeAccounts = async (): Promise<void> => {
      try {
        const nextClaude = await window.api.claudeAccounts.list()
        if (!stale) {
          setClaudeAccounts(nextClaude)
        }
      } catch (error) {
        if (!stale) {
          toast.error('Could not load Claude accounts.', {
            description: String((error as Error)?.message ?? error)
          })
        }
      }
    }

    void loadCodexAccounts()
    void loadClaudeAccounts()

    return () => {
      stale = true
    }
  }, [])

  const syncCodexAccounts = async (next: CodexRateLimitAccountsState): Promise<void> => {
    setCodexAccounts(next)
    setCodexAccountsLoaded(true)
    await fetchSettings()
  }

  const syncClaudeAccounts = async (next: ClaudeRateLimitAccountsState): Promise<void> => {
    setClaudeAccounts(next)
    await fetchSettings()
  }

  const formatAccountTimestamp = (timestamp: number): string => {
    return new Date(timestamp).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    })
  }

  const accountRuntimeControls = (
    <SearchableSetting
      title="Account Location"
      description={`Choose whether provider accounts are inspected and added in ${getHostRuntimeLabel()} or WSL.`}
      keywords={['account', 'location', 'windows', 'wsl', 'linux', 'provider', 'auth']}
    >
      <SettingsRow
        label="Account location"
        alignTop
        description={
          accountRuntime.runtime === 'wsl' && !wslAvailable && !wslCapabilitiesLoading
            ? 'WSL is not available on this machine.'
            : 'Choose which local environment to inspect and where new managed Claude and Codex accounts are added.'
        }
        control={
          <div className="flex w-44 flex-col items-stretch gap-2">
            <SettingsSegmentedControl
              ariaLabel="Account location"
              value={accountRuntime.runtime}
              onChange={(value) => updateSettings({ localAccountRuntime: value })}
              equalWidth
              options={[
                { value: 'host', label: getHostRuntimeLabel() },
                {
                  value: 'wsl',
                  label: 'WSL',
                  disabled: wslCapabilitiesLoading || !wslAvailable
                }
              ]}
            />
            {accountRuntime.runtime === 'wsl' ? (
              <Select
                value={accountRuntime.wslDistro ?? '__default__'}
                onValueChange={(value) =>
                  updateSettings({
                    localAccountRuntime: 'wsl',
                    localAccountWslDistro: value === '__default__' ? null : value
                  })
                }
                disabled={wslCapabilitiesLoading || !wslAvailable}
              >
                <SelectTrigger size="sm" className="w-full min-w-44">
                  <SelectValue
                    placeholder={wslCapabilitiesLoading ? 'Loading WSL' : 'WSL default'}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">WSL default</SelectItem>
                  {wslDistros.map((distro) => (
                    <SelectItem key={distro} value={distro}>
                      {distro}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
        }
      />
    </SearchableSetting>
  )

  const runCodexAccountAction = async (
    action: typeof codexAction,
    operation: () => Promise<CodexRateLimitAccountsState>
  ): Promise<void> => {
    const previousActiveAccountId = getActiveCodexAccountIdForRuntime(codexAccounts, accountRuntime)
    setCodexAction(action)
    try {
      const next = await operation()
      await syncCodexAccounts(next)
      recordFeatureInteraction('codex-account-switching')
      const nextActiveAccountId = getActiveCodexAccountIdForRuntime(next, accountRuntime)
      const shouldPromptRestart =
        action === 'adding' ||
        (action.startsWith('select:') && previousActiveAccountId !== nextActiveAccountId) ||
        (action.startsWith('reauth:') &&
          nextActiveAccountId !== null &&
          action === `reauth:${nextActiveAccountId}`) ||
        (action.startsWith('remove:') && previousActiveAccountId !== nextActiveAccountId)
      if (shouldPromptRestart) {
        void markLiveCodexSessionsForRestart({
          previousAccountLabel: getCodexAccountLabel(codexAccounts, previousActiveAccountId),
          nextAccountLabel: getCodexAccountLabel(next, nextActiveAccountId)
        })
      }
    } catch (error) {
      toast.error('Codex account update failed.', {
        description: getCodexAccountErrorDescription(error)
      })
    } finally {
      setCodexAction('idle')
    }
  }

  const runClaudeAccountAction = async (
    action: typeof claudeAction,
    operation: () => Promise<ClaudeRateLimitAccountsState>
  ): Promise<void> => {
    const previousActiveAccountId = getActiveClaudeAccountIdForRuntime(
      claudeAccounts,
      accountRuntime
    )
    setClaudeAction(action)
    try {
      const next = await operation()
      await syncClaudeAccounts(next)
      recordFeatureInteraction('claude-account-switching')
      const nextActiveAccountId = getActiveClaudeAccountIdForRuntime(next, accountRuntime)
      const shouldPromptRestart =
        action === 'adding' ||
        previousActiveAccountId !== nextActiveAccountId ||
        (action.startsWith('reauth:') &&
          nextActiveAccountId !== null &&
          action === `reauth:${nextActiveAccountId}`)
      if (shouldPromptRestart) {
        toast.info('Claude account updated.', {
          description: `${getClaudeAccountLabel(claudeAccounts, previousActiveAccountId)} -> ${getClaudeAccountLabel(next, nextActiveAccountId)}. Restart live Claude terminals before continuing old sessions.`
        })
      }
    } catch (error) {
      toast.error('Claude account update failed.', {
        description: getClaudeAccountErrorDescription(error)
      })
    } finally {
      setClaudeAction('idle')
    }
  }

  const visibleSections = [
    matchesSettingsSearch(searchQuery, ACCOUNTS_LOCATION_SEARCH_ENTRIES) ? (
      <section key="account-runtime" id="accounts-runtime" className="space-y-3 scroll-mt-6">
        {accountRuntimeControls}
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, ACCOUNTS_CLAUDE_SEARCH_ENTRIES) ? (
      <section key="claude-accounts" id="accounts-claude" className="space-y-4 scroll-mt-6">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <ClaudeIcon size={16} />
            Claude
          </h3>
          <p className="text-xs text-muted-foreground">
            Optional. Orca can use your normal Claude login; add accounts only if you want quick
            switching without moving chat sessions.
          </p>
        </div>

        <SearchableSetting
          title="Claude Accounts"
          description="Optional account switcher for the shared Claude auth files."
          keywords={['claude', 'account', 'rate limit', 'status bar', 'quota']}
          className="space-y-3 py-2"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <Label>Accounts</Label>
              <p className="text-xs text-muted-foreground">
                Showing {accountRuntime.label} accounts. New accounts are added there.
              </p>
            </div>
            <Button
              variant="outline"
              size="xs"
              onClick={() =>
                void runClaudeAccountAction('adding', () =>
                  window.api.claudeAccounts.add({
                    runtime: accountRuntime.runtime,
                    wslDistro: accountRuntime.wslDistro
                  })
                )
              }
              disabled={
                claudeAction !== 'idle' || wslCapabilitiesLoading || accountRuntimeUnavailable
              }
              className="gap-1.5"
            >
              {claudeAction === 'adding' ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Plus className="size-3" />
              )}
              Add Account
            </Button>
          </div>

          <div className="space-y-2">
            <button
              type="button"
              onClick={() =>
                void runClaudeAccountAction('select:system', () =>
                  window.api.claudeAccounts.select({
                    accountId: null,
                    runtime: accountRuntime.runtime,
                    wslDistro: accountRuntime.wslDistro
                  })
                )
              }
              disabled={claudeAction !== 'idle' || accountRuntimeUnavailable}
              className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
                activeClaudeAccountId === null
                  ? 'border-foreground/20 bg-accent/15'
                  : 'border-border/70 hover:border-border hover:bg-accent/8'
              } disabled:cursor-default disabled:opacity-100`}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium">System default</span>
                  {activeClaudeAccountId === null ? (
                    <Badge
                      variant="outline"
                      className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none text-foreground/80"
                    >
                      Active
                    </Badge>
                  ) : null}
                </div>
                <span className="truncate text-[11px] text-muted-foreground">
                  Use your current {accountRuntime.label} Claude login.
                </span>
              </div>
            </button>
            {visibleClaudeAccounts.length === 0 ? (
              <div className="rounded-md border border-dashed border-border/70 px-3 py-4 text-xs text-muted-foreground">
                No managed Claude accounts for {accountRuntime.label}. Orca will use that
                environment&apos;s system default Claude login until you add one here.
              </div>
            ) : (
              visibleClaudeAccounts.map((account) => {
                const isActive = activeClaudeAccountId === account.id
                const isReauthing = claudeAction === `reauth:${account.id}`
                const isBusy = claudeAction !== 'idle' || accountRuntimeUnavailable

                return (
                  <div
                    key={account.id}
                    className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
                      isActive
                        ? 'border-foreground/20 bg-accent/15'
                        : 'border-border/70 hover:border-border hover:bg-accent/8'
                    }`}
                  >
                    <div className="flex w-full items-center justify-between gap-3 max-md:flex-col max-md:items-start">
                      <button
                        type="button"
                        onClick={() =>
                          void runClaudeAccountAction(`select:${account.id}`, () =>
                            window.api.claudeAccounts.select({
                              accountId: account.id,
                              runtime: account.managedAuthRuntime ?? 'host',
                              wslDistro: account.wslDistro ?? null
                            })
                          )
                        }
                        disabled={isBusy}
                        className="flex min-w-0 flex-1 flex-col gap-0.5 text-left disabled:cursor-default"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium">{account.email}</span>
                          <Badge
                            variant="outline"
                            className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none text-foreground/70"
                          >
                            {getClaudeAccountRuntimeLabel(account)}
                          </Badge>
                          {isActive ? (
                            <Badge
                              variant="outline"
                              className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none text-foreground/80"
                            >
                              Active
                            </Badge>
                          ) : null}
                        </div>
                        <span className="truncate text-[11px] text-muted-foreground">
                          {account.organizationName
                            ? `${account.organizationName} · ${formatAccountTimestamp(account.lastAuthenticatedAt)}`
                            : formatAccountTimestamp(account.lastAuthenticatedAt)}
                        </span>
                      </button>
                      <div className="flex shrink-0 items-center justify-end gap-1 max-md:w-full max-md:flex-wrap">
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={(event) => {
                            event.stopPropagation()
                            void runClaudeAccountAction(`reauth:${account.id}`, () =>
                              window.api.claudeAccounts.reauthenticate({ accountId: account.id })
                            )
                          }}
                          disabled={isBusy}
                          className="h-6 px-2 text-muted-foreground hover:text-foreground"
                        >
                          {isReauthing ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <RefreshCw className="size-3" />
                          )}
                          Re-authenticate
                        </Button>
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={(event) => {
                            event.stopPropagation()
                            setRemoveClaudeAccountId(account.id)
                          }}
                          disabled={isBusy}
                          className="h-6 px-2 text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="size-3" />
                          Remove
                        </Button>
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </SearchableSetting>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, ACCOUNTS_CODEX_SEARCH_ENTRIES) ? (
      <section key="codex-accounts" id="accounts-codex" className="space-y-4 scroll-mt-6">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <OpenAIIcon size={16} />
            Codex
          </h3>
          <p className="text-xs text-muted-foreground">
            Optional. Orca can use your normal Codex login; add accounts only if you want quick
            switching in Orca.
          </p>
          <p className="text-xs text-muted-foreground">
            Each account keeps its own local sign-in context in Orca. Account auth stays on this
            device.
          </p>
        </div>

        <SearchableSetting
          title="Codex Accounts"
          description="Manage which Codex account Orca uses for live rate limit fetching."
          // Why: this single SearchableSetting backs the whole Codex section,
          // including the "Active Codex Account" sub-control (account picker
          // below). Roll every Codex search entry's title/description/keywords
          // into one haystack so a search for "Active Codex Account" doesn't
          // render the section header with no body underneath it.
          keywords={ACCOUNTS_CODEX_SEARCH_ENTRIES.flatMap((entry) => [
            entry.title,
            entry.description ?? '',
            ...(entry.keywords ?? [])
          ])}
          className="space-y-3 py-2"
        >
          {/* Why: Settings deep-links can target this subsection directly from
          the status-bar account switcher. Keeping a stable DOM anchor here
          avoids dumping the user at the top of Accounts and making them hunt
          for the actual Codex account controls. */}
          {activeCodexAuthWarning ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {activeCodexAccountId
                  ? 'Codex reported that the active account needs a fresh sign-in. Re-authenticate it before starting new Codex sessions.'
                  : `Codex reported that the ${accountRuntime.label} login needs a fresh sign-in. Sign in again before starting new Codex sessions.`}
              </span>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <Label>Accounts</Label>
              <p className="text-xs text-muted-foreground">
                Showing {accountRuntime.label} accounts. New accounts are added there.
              </p>
            </div>
            <Button
              variant="outline"
              size="xs"
              onClick={() =>
                void runCodexAccountAction('adding', () =>
                  window.api.codexAccounts.add({
                    runtime: accountRuntime.runtime,
                    wslDistro: accountRuntime.wslDistro
                  })
                )
              }
              disabled={
                codexAction !== 'idle' || wslCapabilitiesLoading || accountRuntimeUnavailable
              }
              className="gap-1.5"
            >
              {codexAction === 'adding' ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Plus className="size-3" />
              )}
              Add Account
            </Button>
          </div>

          <div className="space-y-2">
            <button
              type="button"
              onClick={() =>
                void runCodexAccountAction('select:system', () =>
                  window.api.codexAccounts.select({
                    accountId: null,
                    runtime: accountRuntime.runtime,
                    wslDistro: accountRuntime.wslDistro
                  })
                )
              }
              disabled={codexAction !== 'idle' || accountRuntimeUnavailable}
              className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
                systemCodexNeedsReauthentication
                  ? 'border-destructive/50 bg-destructive/5'
                  : activeCodexAccountId === null
                    ? 'border-foreground/20 bg-accent/15'
                    : 'border-border/70 hover:border-border hover:bg-accent/8'
              } disabled:cursor-default disabled:opacity-100`}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium">System default</span>
                  {activeCodexAccountId === null ? (
                    <Badge
                      variant="outline"
                      className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none text-foreground/80"
                    >
                      Active
                    </Badge>
                  ) : null}
                  {systemCodexNeedsReauthentication ? (
                    <Badge
                      variant="destructive"
                      className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none"
                    >
                      Needs sign-in
                    </Badge>
                  ) : null}
                </div>
                <span
                  className={`truncate text-[11px] ${
                    systemCodexNeedsReauthentication ? 'text-destructive' : 'text-muted-foreground'
                  }`}
                >
                  {systemCodexNeedsReauthentication
                    ? `Codex reported this ${accountRuntime.label} login is out of date.`
                    : `Use your current ${accountRuntime.label} Codex login.`}
                </span>
              </div>
            </button>
            {visibleCodexAccounts.length === 0 ? (
              <div className="rounded-md border border-dashed border-border/70 px-3 py-4 text-xs text-muted-foreground">
                No managed Codex accounts for {accountRuntime.label}. Orca will use that
                environment&apos;s system default Codex login until you add one here.
              </div>
            ) : (
              visibleCodexAccounts.map((account) => {
                const isActive = activeCodexAccountId === account.id
                const accountAuthWarning = getCodexAccountAuthWarning({
                  limits: codexRateLimits,
                  target: codexRateLimitTarget,
                  runtime: accountRuntime,
                  activeAccountId: activeCodexAccountId,
                  accountId: account.id
                })
                const needsReauthentication = Boolean(accountAuthWarning)
                const isReauthing = codexAction === `reauth:${account.id}`
                const isRemoving = codexAction === `remove:${account.id}`
                const isBusy = codexAction !== 'idle' || accountRuntimeUnavailable

                return (
                  <div
                    key={account.id}
                    className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
                      needsReauthentication
                        ? 'border-destructive/50 bg-destructive/5'
                        : isActive
                          ? 'border-foreground/20 bg-accent/15'
                          : 'border-border/70 hover:border-border hover:bg-accent/8'
                    }`}
                  >
                    <div className="flex w-full items-center justify-between gap-3 max-md:flex-col max-md:items-start">
                      <button
                        type="button"
                        onClick={() =>
                          void runCodexAccountAction(`select:${account.id}`, () =>
                            window.api.codexAccounts.select({
                              accountId: account.id,
                              runtime: account.managedHomeRuntime ?? 'host',
                              wslDistro: account.wslDistro ?? null
                            })
                          )
                        }
                        disabled={isBusy}
                        className="flex min-w-0 flex-1 flex-col gap-0.5 text-left disabled:cursor-default"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium">{account.email}</span>
                          <Badge
                            variant="outline"
                            className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none text-foreground/70"
                          >
                            {getCodexAccountRuntimeLabel(account)}
                          </Badge>
                          {isActive ? (
                            <Badge
                              variant="outline"
                              className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none text-foreground/80"
                            >
                              Active
                            </Badge>
                          ) : null}
                          {needsReauthentication ? (
                            <Badge
                              variant="destructive"
                              className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none"
                            >
                              Needs re-auth
                            </Badge>
                          ) : null}
                        </div>
                        <div
                          className={`flex min-w-0 items-center gap-1.5 text-[11px] max-sm:flex-wrap ${
                            needsReauthentication ? 'text-destructive' : 'text-muted-foreground'
                          }`}
                        >
                          {needsReauthentication ? (
                            <span className="truncate">
                              Codex reported this sign-in is out of date
                            </span>
                          ) : account.workspaceLabel ? (
                            <span className="truncate">{account.workspaceLabel}</span>
                          ) : null}
                          {needsReauthentication || account.workspaceLabel ? (
                            <span className="shrink-0 opacity-50">•</span>
                          ) : null}
                          <span className="shrink-0">
                            {formatAccountTimestamp(account.lastAuthenticatedAt)}
                          </span>
                        </div>
                      </button>

                      <div className="flex shrink-0 items-center justify-end gap-1 max-md:w-full max-md:flex-wrap">
                        {/* Why: selecting an account is the primary action in this row.
                        Keeping maintenance actions visually lighter prevents re-auth/remove
                        controls from overpowering the selection affordance in a dense list. */}
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={(event) => {
                            event.stopPropagation()
                            void runCodexAccountAction(`reauth:${account.id}`, () =>
                              window.api.codexAccounts.reauthenticate({ accountId: account.id })
                            )
                          }}
                          disabled={isBusy}
                          className="h-6 px-2 text-muted-foreground hover:text-foreground"
                        >
                          {isReauthing ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <RefreshCw className="size-3" />
                          )}
                          Re-authenticate
                        </Button>
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={(event) => {
                            event.stopPropagation()
                            setRemoveAccountId(account.id)
                          }}
                          disabled={isBusy}
                          className="h-6 px-2 text-muted-foreground hover:text-destructive"
                        >
                          {isRemoving ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <Trash2 className="size-3" />
                          )}
                          Remove
                        </Button>
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </SearchableSetting>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, ACCOUNTS_GEMINI_SEARCH_ENTRIES) ? (
      <section key="gemini" id="accounts-gemini" className="space-y-4 scroll-mt-6">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <GeminiIcon size={16} />
            Gemini
          </h3>
          <p className="text-xs text-muted-foreground">Configure Gemini provider settings.</p>
        </div>

        <SearchableSetting
          title="Use Gemini CLI credentials"
          description="Extracts OAuth credentials from your local Gemini CLI installation to authenticate with Google. This uses credentials issued to the Gemini CLI app, not Orca. May break if Google updates the CLI. Use at your own risk."
          keywords={[
            'gemini',
            'cli',
            'oauth',
            'credentials',
            'experimental',
            'rate limit',
            'status bar'
          ]}
          className="flex items-center justify-between gap-4 py-2"
        >
          <div className="space-y-0.5">
            <Label>Use Gemini CLI credentials (experimental)</Label>
            <p className="text-xs text-muted-foreground">
              Extracts OAuth credentials from your local Gemini CLI installation to authenticate
              with Google for {accountRuntime.label}. This uses credentials issued to the Gemini CLI
              app, not Orca. May break if Google updates the CLI. Use at your own risk.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={settings.geminiCliOAuthEnabled}
            onClick={() => {
              recordFeatureInteraction('usage-tracking')
              updateSettings({
                geminiCliOAuthEnabled: !settings.geminiCliOAuthEnabled
              })
            }}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
              settings.geminiCliOAuthEnabled ? 'bg-foreground' : 'bg-muted-foreground/30'
            }`}
          >
            <span
              className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                settings.geminiCliOAuthEnabled ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </SearchableSetting>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, ACCOUNTS_OPENCODE_SEARCH_ENTRIES) ? (
      <section key="opencode-go" id="accounts-opencode-go" className="space-y-4 scroll-mt-6">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <OpenCodeGoIcon size={16} />
            OpenCode Go
          </h3>
          <p className="text-xs text-muted-foreground">Configure OpenCode Go provider settings.</p>
        </div>

        <SearchableSetting
          title="OpenCode Go Session Cookie"
          description="Paste your opencode.ai session cookie for rate limit fetching."
          keywords={['opencode', 'cookie', 'session', 'rate limit', 'status bar']}
          className="space-y-2"
        >
          <Label>OpenCode Go session cookie</Label>
          <div className="flex gap-2">
            <Input
              type="password"
              value={settings.opencodeSessionCookie}
              onChange={(e) => {
                recordOpenCodeSettingEdit('cookie')
                updateSettings({ opencodeSessionCookie: e.target.value })
              }}
              placeholder="Fe26.2**… token or auth=Fe26.2**… header"
              spellCheck={false}
              className="flex-1 text-xs"
            />
            {settings.opencodeSessionCookie && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  recordFeatureInteraction('usage-tracking')
                  updateSettings({ opencodeSessionCookie: '' })
                }}
                className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground"
              >
                Clear
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Paste either the raw token value (e.g. <code className="text-xs">Fe26.2**…</code>) or
            the full cookie header (e.g. <code className="text-xs">auth=Fe26.2**…</code>). Find it
            in your browser&apos;s DevTools → Network → any opencode.ai request → Cookie header.
            OpenCode Go auth is web-based and shared across Windows and WSL terminals.
          </p>
        </SearchableSetting>

        <SearchableSetting
          title="OpenCode Go Workspace ID"
          description="Optional workspace ID override if the automatic lookup fails."
          keywords={['opencode', 'workspace', 'id', 'wrk', 'rate limit', 'status bar']}
          className="space-y-2"
        >
          <Label>Workspace ID override</Label>
          <div className="flex gap-2">
            <Input
              type="text"
              value={settings.opencodeWorkspaceId}
              onChange={(e) => {
                recordOpenCodeSettingEdit('workspaceId')
                updateSettings({ opencodeWorkspaceId: e.target.value })
              }}
              placeholder="wrk_…  (leave blank for automatic lookup)"
              spellCheck={false}
              className="flex-1 text-xs"
            />
            {settings.opencodeWorkspaceId && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  recordFeatureInteraction('usage-tracking')
                  updateSettings({ opencodeWorkspaceId: '' })
                }}
                className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground"
              >
                Clear
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Find this in the URL after logging into opencode.ai (e.g.{' '}
            <code className="text-xs">opencode.ai/workspace/wrk_…/go</code>).
          </p>
        </SearchableSetting>
      </section>
    ) : null
  ].filter(Boolean)

  return (
    <div className="space-y-8">
      <Dialog
        open={removeAccountId !== null}
        onOpenChange={(open) => !open && setRemoveAccountId(null)}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Remove Codex Account?</DialogTitle>
            <DialogDescription>
              Orca will delete the managed Codex home for this saved account. If it is currently
              active, Orca falls back to the system default Codex login.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveAccountId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const accountId = removeAccountId
                if (!accountId) {
                  return
                }
                setRemoveAccountId(null)
                void runCodexAccountAction(`remove:${accountId}`, () =>
                  window.api.codexAccounts.remove({ accountId })
                )
              }}
            >
              Remove Account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={removeClaudeAccountId !== null}
        onOpenChange={(open) => !open && setRemoveClaudeAccountId(null)}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Remove Claude Account?</DialogTitle>
            <DialogDescription>
              Orca will delete the managed Claude auth for this saved account. If it is currently
              active, Orca falls back to the system default Claude login.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveClaudeAccountId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const accountId = removeClaudeAccountId
                if (!accountId) {
                  return
                }
                setRemoveClaudeAccountId(null)
                void runClaudeAccountAction(`remove:${accountId}`, () =>
                  window.api.claudeAccounts.remove({ accountId })
                )
              }}
            >
              Remove Account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {visibleSections.map((section, index) => (
        <div key={index} className="space-y-8">
          {index > 0 ? <Separator /> : null}
          {section}
        </div>
      ))}
    </div>
  )
}
