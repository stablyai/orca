/* eslint-disable max-lines -- Why: AccountsPane owns all per-provider account UI
   (Claude, Codex, Gemini, OpenCode Go, and future providers). Each provider's
   add/select/reauth/remove flow is tightly coupled to the provider-specific
   error handling and restart prompts below; splitting them into separate files
   would scatter those flows without a meaningful abstraction boundary. */
import { useEffect, useState } from 'react'
import type {
  AddClaudeAccountInput,
  ClaudeAccountValidationResult,
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState,
  GlobalSettings
} from '../../../../shared/types'
import { AddAccountModal, type AddAccountSubmit } from './AddAccountModal'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { AlertTriangle, CheckCircle2, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useAppStore } from '../../store'
import { ClaudeIcon, GeminiIcon, OpenAIIcon, OpenCodeGoIcon } from '../status-bar/icons'
import { toast } from 'sonner'
import {
  ACCOUNTS_CLAUDE_SEARCH_ENTRIES,
  ACCOUNTS_CODEX_SEARCH_ENTRIES,
  ACCOUNTS_GEMINI_SEARCH_ENTRIES,
  ACCOUNTS_OPENCODE_SEARCH_ENTRIES,
  ACCOUNTS_PANE_SEARCH_ENTRIES
} from './accounts-search'
import { SearchableSetting } from './SearchableSetting'
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

export { ACCOUNTS_PANE_SEARCH_ENTRIES }

type AccountsPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
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

function getClaudeAccountLabel(
  state: ClaudeRateLimitAccountsState,
  accountId: string | null | undefined
): string {
  if (accountId == null) {
    return 'System default'
  }
  return state.accounts.find((account) => account.id === accountId)?.email ?? 'Claude account'
}

// Why: Design F3.1 — switching accounts must surface the new-PTY-only semantics so
// users understand that running terminals keep their previous auth until restart.
// Extracted as a pure helper so the wording is unit-tested without rendering React.
export function buildClaudeSwitchToastMessage(account: { email: string }): string {
  return `Switched to ${account.email}. Existing terminals keep their previous account until restarted.`
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

/**
 * Decide what the Claude "Add account" button should do.
 *
 * Flag off: trigger the legacy OAuth no-arg `add()` flow inline.
 * Flag on: open the multi-provider AddAccountModal instead.
 *
 * Extracted as a pure helper so the routing logic is unit-testable without
 * rendering the full AccountsPane tree.
 */
export function resolveClaudeAddAccountAction(
  multiProviderEnabled: boolean | undefined
): 'open-modal' | 'run-oauth' {
  return multiProviderEnabled === true ? 'open-modal' : 'run-oauth'
}

/**
 * Map an AddAccountModal submit payload to the IPC `claudeAccounts.add` input.
 *
 * The modal's submit shape is a subset of the polymorphic IPC input (OAuth
 * never reaches submit — it would open an external browser flow), so the
 * mapping is mostly identity. Centralized here so the IPC contract stays
 * provable in one place.
 */
export function buildClaudeAddAccountInput(submit: AddAccountSubmit): AddClaudeAccountInput {
  return submit
}

/**
 * Render the validation state for a single Claude managed account row.
 *
 * Exported separately from the AccountsPane render path so the three-state
 * (unvalidated / valid / invalid / pending) decoration logic is unit-testable
 * without rendering the full settings tree.
 */
export type ClaudeValidationBadgeState =
  | { kind: 'unvalidated' }
  | { kind: 'pending' }
  | { kind: 'valid' }
  | { kind: 'invalid'; reason: string; rescueHint?: string }

export function pickClaudeValidationBadgeState(
  entry: ClaudeAccountValidationResult | 'pending' | undefined
): ClaudeValidationBadgeState {
  if (entry === undefined) return { kind: 'unvalidated' }
  if (entry === 'pending') return { kind: 'pending' }
  if (entry.ok) return { kind: 'valid' }
  return { kind: 'invalid', reason: entry.reason, rescueHint: entry.rescueHint }
}

function ClaudeValidationBadge({
  state
}: {
  state: ClaudeValidationBadgeState
}): React.JSX.Element | null {
  if (state.kind === 'unvalidated') {
    return (
      <Badge
        variant="outline"
        className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none text-muted-foreground"
      >
        Unvalidated
      </Badge>
    )
  }
  if (state.kind === 'pending') {
    return (
      <Badge
        variant="outline"
        className="h-4 shrink-0 gap-1 rounded px-1.5 text-[10px] font-medium leading-none text-muted-foreground"
      >
        <Loader2 className="size-2.5 animate-spin" />
        Validating
      </Badge>
    )
  }
  if (state.kind === 'valid') {
    return (
      <Badge
        variant="outline"
        className="h-4 shrink-0 gap-1 rounded border-emerald-500/40 px-1.5 text-[10px] font-medium leading-none text-emerald-600 dark:text-emerald-400"
      >
        <CheckCircle2 className="size-2.5" />
        Valid
      </Badge>
    )
  }
  return (
    <Badge
      variant="outline"
      className="h-4 shrink-0 gap-1 rounded border-destructive/40 px-1.5 text-[10px] font-medium leading-none text-destructive"
    >
      <AlertTriangle className="size-2.5" />
      Invalid
    </Badge>
  )
}

export function AccountsPane({ settings, updateSettings }: AccountsPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  const fetchSettings = useAppStore((s) => s.fetchSettings)

  const [codexAccounts, setCodexAccounts] = useState<CodexRateLimitAccountsState>({
    accounts: [],
    activeAccountId: null
  })
  const [codexAction, setCodexAction] = useState<
    'idle' | 'adding' | `reauth:${string}` | `remove:${string}` | `select:${string | 'system'}`
  >('idle')
  const [claudeAccounts, setClaudeAccounts] = useState<ClaudeRateLimitAccountsState>({
    accounts: [],
    activeAccountId: null
  })
  const [claudeAction, setClaudeAction] = useState<
    'idle' | 'adding' | `reauth:${string}` | `remove:${string}` | `select:${string | 'system'}`
  >('idle')
  const [removeAccountId, setRemoveAccountId] = useState<string | null>(null)
  const [removeClaudeAccountId, setRemoveClaudeAccountId] = useState<string | null>(null)
  // Why: gated behind `claudeMultiProviderEnabled`. With the flag off this
  // state is unused and the "Add account" button keeps its legacy OAuth path.
  const [addClaudeModalOpen, setAddClaudeModalOpen] = useState(false)
  // Why: per-account live-validation state, keyed by account id. Renderer-only —
  // we never persist this; on every settings open the user sees "Unvalidated"
  // until they click Re-check (or the auto-validate-on-add path fires).
  const [claudeValidation, setClaudeValidation] = useState<
    Record<string, ClaudeAccountValidationResult | 'pending'>
  >({})

  useEffect(() => {
    let stale = false

    const loadCodexAccounts = async (): Promise<void> => {
      try {
        const nextCodex = await window.api.codexAccounts.list()
        if (!stale) {
          setCodexAccounts(nextCodex)
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

  const runCodexAccountAction = async (
    action: typeof codexAction,
    operation: () => Promise<CodexRateLimitAccountsState>
  ): Promise<void> => {
    const previousActiveAccountId = codexAccounts.activeAccountId
    setCodexAction(action)
    try {
      const next = await operation()
      await syncCodexAccounts(next)
      const shouldPromptRestart =
        action === 'adding' ||
        (action.startsWith('select:') && previousActiveAccountId !== next.activeAccountId) ||
        (action.startsWith('reauth:') &&
          next.activeAccountId !== null &&
          action === `reauth:${next.activeAccountId}`) ||
        (action.startsWith('remove:') && previousActiveAccountId !== next.activeAccountId)
      if (shouldPromptRestart) {
        void markLiveCodexSessionsForRestart({
          previousAccountLabel: getCodexAccountLabel(codexAccounts, previousActiveAccountId),
          nextAccountLabel: getCodexAccountLabel(next, next.activeAccountId)
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
    const previousActiveAccountId = claudeAccounts.activeAccountId
    setClaudeAction(action)
    try {
      const next = await operation()
      await syncClaudeAccounts(next)
      if (previousActiveAccountId !== next.activeAccountId || action === 'adding') {
        // Why: Design F3.1 — surface that the switch only affects new terminals.
        // Existing PTYs keep their previous auth until restarted.
        toast.info(
          buildClaudeSwitchToastMessage({
            email: getClaudeAccountLabel(next, next.activeAccountId)
          })
        )
      }
    } catch (error) {
      toast.error('Claude account update failed.', {
        description: getClaudeAccountErrorDescription(error)
      })
    } finally {
      setClaudeAction('idle')
    }
  }

  // Why: Re-check button fires a one-shot validation probe. We track 'pending'
  // separately from the result so the row can show a spinner; any prior result
  // stays in state until replaced so the user never sees the badge flicker
  // back to "Unvalidated" mid-probe.
  const runClaudeValidate = async (accountId: string): Promise<void> => {
    setClaudeValidation((prev) => ({ ...prev, [accountId]: 'pending' }))
    try {
      const result = await window.api.claudeAccounts.validate({ accountId })
      setClaudeValidation((prev) => ({ ...prev, [accountId]: result }))
    } catch (error) {
      setClaudeValidation((prev) => ({
        ...prev,
        [accountId]: {
          ok: false,
          reason:
            String((error as Error)?.message ?? error)
              .replace(/^Error invoking remote method [^:]+:\s*/, '')
              .replace(/^Error:\s*/, '')
              .trim() || 'Validation failed.'
        }
      }))
    }
  }

  const visibleSections = [
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
          className="space-y-3 px-1 py-2"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <Label>Accounts</Label>
              <p className="text-xs text-muted-foreground">
                Orca swaps Claude auth only; config and chat history stay in the shared Claude root.
              </p>
            </div>
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                if (resolveClaudeAddAccountAction(settings.claudeMultiProviderEnabled) === 'open-modal') {
                  setAddClaudeModalOpen(true)
                  return
                }
                void runClaudeAccountAction('adding', () => window.api.claudeAccounts.add())
              }}
              disabled={claudeAction !== 'idle'}
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
                  window.api.claudeAccounts.select({ accountId: null })
                )
              }
              disabled={claudeAction !== 'idle'}
              className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
                claudeAccounts.activeAccountId === null
                  ? 'border-foreground/20 bg-accent/15'
                  : 'border-border/70 hover:border-border hover:bg-accent/8'
              }`}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium">System default</span>
                  {claudeAccounts.activeAccountId === null ? (
                    <Badge
                      variant="outline"
                      className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none text-foreground/80"
                    >
                      Active
                    </Badge>
                  ) : null}
                </div>
                <span className="truncate text-[11px] text-muted-foreground">
                  Use your current system Claude login.
                </span>
              </div>
            </button>
            {claudeAccounts.accounts.length === 0 ? (
              <div className="rounded-md border border-dashed border-border/70 px-3 py-4 text-xs text-muted-foreground">
                No managed Claude accounts yet. Orca will use your system default Claude login until
                you add one here.
              </div>
            ) : (
              claudeAccounts.accounts.map((account) => {
                const isActive = claudeAccounts.activeAccountId === account.id
                const isReauthing = claudeAction === `reauth:${account.id}`
                const isBusy = claudeAction !== 'idle'
                const validationState = pickClaudeValidationBadgeState(
                  claudeValidation[account.id]
                )

                return (
                  <div
                    key={account.id}
                    className={`flex w-full flex-col gap-1.5 rounded-md border px-3 py-2.5 text-left transition-colors ${
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
                            window.api.claudeAccounts.select({ accountId: account.id })
                          )
                        }
                        disabled={isBusy}
                        className="flex min-w-0 flex-1 flex-col gap-0.5 text-left disabled:cursor-default"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium">{account.email}</span>
                          {isActive ? (
                            <Badge
                              variant="outline"
                              className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none text-foreground/80"
                            >
                              Active
                            </Badge>
                          ) : null}
                          <ClaudeValidationBadge state={validationState} />
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
                          aria-label="Re-check"
                          onClick={(event) => {
                            event.stopPropagation()
                            void runClaudeValidate(account.id)
                          }}
                          disabled={isBusy || validationState.kind === 'pending'}
                          className="h-6 px-2 text-muted-foreground hover:text-foreground"
                        >
                          {validationState.kind === 'pending' ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <RefreshCw className="size-3" />
                          )}
                          Re-check
                        </Button>
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
                    {validationState.kind === 'invalid' ? (
                      <p className="text-[11px] text-destructive">
                        {validationState.reason}
                        {validationState.rescueHint ? (
                          <span className="text-muted-foreground"> {validationState.rescueHint}</span>
                        ) : null}
                      </p>
                    ) : null}
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
          className="space-y-3 px-1 py-2"
        >
          {/* Why: Settings deep-links can target this subsection directly from
          the status-bar account switcher. Keeping a stable DOM anchor here
          avoids dumping the user at the top of Accounts and making them hunt
          for the actual Codex account controls. */}
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <Label>Accounts</Label>
              <p className="text-xs text-muted-foreground">
                Add a Codex account to use it in Orca.
              </p>
            </div>
            <Button
              variant="outline"
              size="xs"
              onClick={() =>
                void runCodexAccountAction('adding', () => window.api.codexAccounts.add())
              }
              disabled={codexAction !== 'idle'}
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

          {codexAccounts.accounts.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/70 px-3 py-4 text-xs text-muted-foreground">
              No managed Codex accounts yet. Orca will use your system default Codex login until you
              add one here.
            </div>
          ) : (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() =>
                  void runCodexAccountAction('select:system', () =>
                    window.api.codexAccounts.select({ accountId: null })
                  )
                }
                disabled={codexAction !== 'idle'}
                className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
                  codexAccounts.activeAccountId === null
                    ? 'border-foreground/20 bg-accent/15'
                    : 'border-border/70 hover:border-border hover:bg-accent/8'
                } disabled:cursor-default disabled:opacity-100`}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium">System default</span>
                    {codexAccounts.activeAccountId === null ? (
                      <Badge
                        variant="outline"
                        className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none text-foreground/80"
                      >
                        Active
                      </Badge>
                    ) : null}
                  </div>
                  <span className="truncate text-[11px] text-muted-foreground">
                    Use your current system Codex login.
                  </span>
                </div>
              </button>
              {codexAccounts.accounts.map((account) => {
                const isActive = codexAccounts.activeAccountId === account.id
                const isReauthing = codexAction === `reauth:${account.id}`
                const isRemoving = codexAction === `remove:${account.id}`
                const isBusy = codexAction !== 'idle'

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
                          void runCodexAccountAction(`select:${account.id}`, () =>
                            window.api.codexAccounts.select({ accountId: account.id })
                          )
                        }
                        disabled={isBusy}
                        className="flex min-w-0 flex-1 flex-col gap-0.5 text-left disabled:cursor-default"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium">{account.email}</span>
                          {isActive ? (
                            <Badge
                              variant="outline"
                              className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none text-foreground/80"
                            >
                              Active
                            </Badge>
                          ) : null}
                        </div>
                        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground max-sm:flex-wrap">
                          {account.workspaceLabel ? (
                            <span className="truncate">{account.workspaceLabel}</span>
                          ) : null}
                          {account.workspaceLabel ? (
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
              })}
            </div>
          )}
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
          className="flex items-center justify-between gap-4 px-1 py-2"
        >
          <div className="space-y-0.5">
            <Label>Use Gemini CLI credentials (experimental)</Label>
            <p className="text-xs text-muted-foreground">
              Extracts OAuth credentials from your local Gemini CLI installation to authenticate
              with Google. This uses credentials issued to the Gemini CLI app, not Orca. May break
              if Google updates the CLI. Use at your own risk.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={settings.geminiCliOAuthEnabled}
            onClick={() =>
              updateSettings({
                geminiCliOAuthEnabled: !settings.geminiCliOAuthEnabled
              })
            }
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
              onChange={(e) => updateSettings({ opencodeSessionCookie: e.target.value })}
              placeholder="Fe26.2**… token or auth=Fe26.2**… header"
              spellCheck={false}
              className="flex-1 text-xs"
            />
            {settings.opencodeSessionCookie && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => updateSettings({ opencodeSessionCookie: '' })}
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
              onChange={(e) => updateSettings({ opencodeWorkspaceId: e.target.value })}
              placeholder="wrk_…  (leave blank for automatic lookup)"
              spellCheck={false}
              className="flex-1 text-xs"
            />
            {settings.opencodeWorkspaceId && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => updateSettings({ opencodeWorkspaceId: '' })}
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
      <AddAccountModal
        open={addClaudeModalOpen}
        onOpenChange={setAddClaudeModalOpen}
        onSubmit={(submit) => {
          // Why: modal submit always carries an enabled provider variant; OAuth
          // is the no-arg legacy path that never round-trips through the modal.
          const input = buildClaudeAddAccountInput(submit)
          setAddClaudeModalOpen(false)
          void runClaudeAccountAction('adding', () => window.api.claudeAccounts.add(input))
        }}
      />
      {visibleSections.map((section, index) => (
        <div key={index} className="space-y-8">
          {index > 0 ? <Separator /> : null}
          {section}
        </div>
      ))}
    </div>
  )
}
