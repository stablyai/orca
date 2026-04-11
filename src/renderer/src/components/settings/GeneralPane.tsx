/* eslint-disable max-lines -- Why: GeneralPane is the single owner of all general settings UI;
   splitting individual settings into separate files would scatter related controls without a
   meaningful abstraction boundary. */
import { useEffect, useState } from 'react'
import type { CodexRateLimitAccountsState, GlobalSettings } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { Download, FolderOpen, Loader2, Plus, RefreshCw, Timer, Trash2 } from 'lucide-react'
import { useAppStore } from '../../store'
import { CliSection } from './CliSection'
import { toast } from 'sonner'
import {
  DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS,
  MAX_EDITOR_AUTO_SAVE_DELAY_MS,
  MIN_EDITOR_AUTO_SAVE_DELAY_MS
} from '../../../../shared/constants'
import { clampNumber } from '@/lib/terminal-theme'
import {
  GENERAL_BROWSER_SEARCH_ENTRIES,
  GENERAL_CODEX_ACCOUNTS_SEARCH_ENTRIES,
  GENERAL_CACHE_TIMER_SEARCH_ENTRIES,
  GENERAL_CLI_SEARCH_ENTRIES,
  GENERAL_EDITOR_SEARCH_ENTRIES,
  GENERAL_PANE_SEARCH_ENTRIES,
  GENERAL_UPDATE_SEARCH_ENTRIES,
  GENERAL_WORKSPACE_SEARCH_ENTRIES
} from './general-search'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
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

export { GENERAL_PANE_SEARCH_ENTRIES }

type GeneralPaneProps = {
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

export function GeneralPane({ settings, updateSettings }: GeneralPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  const updateStatus = useAppStore((s) => s.updateStatus)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [autoSaveDelayDraft, setAutoSaveDelayDraft] = useState(
    String(settings.editorAutoSaveDelayMs)
  )
  const [codexAccounts, setCodexAccounts] = useState<CodexRateLimitAccountsState>({
    accounts: [],
    activeAccountId: null
  })
  const [codexAction, setCodexAction] = useState<
    'idle' | 'adding' | `reauth:${string}` | `remove:${string}` | `select:${string | 'system'}`
  >('idle')
  const [removeAccountId, setRemoveAccountId] = useState<string | null>(null)

  useEffect(() => {
    window.api.updater.getVersion().then(setAppVersion)
  }, [])

  useEffect(() => {
    setAutoSaveDelayDraft(String(settings.editorAutoSaveDelayMs))
  }, [settings.editorAutoSaveDelayMs])

  useEffect(() => {
    let stale = false

    const loadCodexAccounts = async (): Promise<void> => {
      try {
        const next = await window.api.codexAccounts.list()
        if (!stale) {
          setCodexAccounts(next)
        }
      } catch (error) {
        if (!stale) {
          toast.error('Could not load Codex accounts.', {
            description: String((error as Error)?.message ?? error)
          })
        }
      }
    }

    void loadCodexAccounts()

    return () => {
      stale = true
    }
  }, [])

  const handleBrowseWorkspace = async () => {
    const path = await window.api.repos.pickFolder()
    if (path) {
      updateSettings({ workspaceDir: path })
    }
  }

  const commitAutoSaveDelay = (): void => {
    const trimmed = autoSaveDelayDraft.trim()
    if (trimmed === '') {
      setAutoSaveDelayDraft(String(settings.editorAutoSaveDelayMs))
      return
    }

    const value = Number(trimmed)
    if (!Number.isFinite(value)) {
      setAutoSaveDelayDraft(String(settings.editorAutoSaveDelayMs))
      return
    }

    const next = clampNumber(
      Math.round(value),
      MIN_EDITOR_AUTO_SAVE_DELAY_MS,
      MAX_EDITOR_AUTO_SAVE_DELAY_MS
    )
    updateSettings({ editorAutoSaveDelayMs: next })
    setAutoSaveDelayDraft(String(next))
  }

  const handleRestartToUpdate = (): void => {
    void window.api.updater.quitAndInstall().catch((error) => {
      toast.error('Could not restart to install the update.', {
        description: String((error as Error)?.message ?? error)
      })
    })
  }

  const syncCodexAccounts = async (next: CodexRateLimitAccountsState): Promise<void> => {
    setCodexAccounts(next)
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
        description: String((error as Error)?.message ?? error)
      })
    } finally {
      setCodexAction('idle')
    }
  }

  const visibleSections = [
    matchesSettingsSearch(searchQuery, GENERAL_WORKSPACE_SEARCH_ENTRIES) ? (
      <section key="workspace" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Workspace</h3>
          <p className="text-xs text-muted-foreground">
            Configure where new worktrees are created.
          </p>
        </div>

        <SearchableSetting
          title="Workspace Directory"
          description="Root directory where worktree folders are created."
          keywords={['workspace', 'folder', 'path', 'worktree']}
          className="space-y-2"
        >
          <Label>Workspace Directory</Label>
          <div className="flex gap-2">
            <Input
              value={settings.workspaceDir}
              onChange={(e) => updateSettings({ workspaceDir: e.target.value })}
              className="flex-1 text-xs"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={handleBrowseWorkspace}
              className="shrink-0 gap-1.5"
            >
              <FolderOpen className="size-3.5" />
              Browse
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Root directory where worktree folders are created.
          </p>
        </SearchableSetting>

        <SearchableSetting
          title="Nest Workspaces"
          description="Create worktrees inside a repo-named subfolder."
          keywords={['nested', 'subfolder', 'directory']}
          className="flex items-center justify-between gap-4 px-1 py-2"
        >
          <div className="space-y-0.5">
            <Label>Nest Workspaces</Label>
            <p className="text-xs text-muted-foreground">
              Create worktrees inside a repo-named subfolder.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={settings.nestWorkspaces}
            onClick={() =>
              updateSettings({
                nestWorkspaces: !settings.nestWorkspaces
              })
            }
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
              settings.nestWorkspaces ? 'bg-foreground' : 'bg-muted-foreground/30'
            }`}
          >
            <span
              className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                settings.nestWorkspaces ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </SearchableSetting>

      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, GENERAL_BROWSER_SEARCH_ENTRIES) ? (
      <section key="browser" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Browser</h3>
          <p className="text-xs text-muted-foreground">
            Control how Orca handles links from the terminal.
          </p>
        </div>

        <SearchableSetting
          title="Open Links In Orca"
          description="Open terminal http(s) links in Orca browser tabs instead of the system browser."
          keywords={['browser', 'preview', 'links', 'localhost', 'webview']}
          className="flex items-center justify-between gap-4 px-1 py-2"
        >
          <div className="space-y-0.5">
            <Label>Open Links In Orca</Label>
            <p className="text-xs text-muted-foreground">
              Open terminal http(s) links in isolated Orca browser tabs instead of the system
              browser.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={settings.openLinksInApp}
            onClick={() =>
              updateSettings({
                openLinksInApp: !settings.openLinksInApp
              })
            }
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
              settings.openLinksInApp ? 'bg-foreground' : 'bg-muted-foreground/30'
            }`}
          >
            <span
              className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                settings.openLinksInApp ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </SearchableSetting>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, GENERAL_EDITOR_SEARCH_ENTRIES) ? (
      <section key="editor" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Editor</h3>
          <p className="text-xs text-muted-foreground">Configure how Orca persists file edits.</p>
        </div>

        <SearchableSetting
          title="Auto Save Files"
          description="Save editor and editable diff changes automatically after a short pause."
          keywords={['autosave', 'save']}
          className="flex items-center justify-between gap-4 px-1 py-2"
        >
          <div className="space-y-0.5">
            <Label>Auto Save Files</Label>
            <p className="text-xs text-muted-foreground">
              Save editor and editable diff changes automatically after a short pause.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={settings.editorAutoSave}
            onClick={() =>
              updateSettings({
                editorAutoSave: !settings.editorAutoSave
              })
            }
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
              settings.editorAutoSave ? 'bg-foreground' : 'bg-muted-foreground/30'
            }`}
          >
            <span
              className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                settings.editorAutoSave ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </SearchableSetting>

        <SearchableSetting
          title="Auto Save Delay"
          description="How long Orca waits after your last edit before saving automatically."
          keywords={['autosave', 'delay', 'milliseconds']}
          className="flex items-center justify-between gap-4 px-1 py-2"
        >
          <div className="space-y-0.5">
            <Label>Auto Save Delay</Label>
            <p className="text-xs text-muted-foreground">
              How long Orca waits after your last edit before saving automatically. First launch
              defaults to {DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS} ms.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Input
              type="number"
              min={MIN_EDITOR_AUTO_SAVE_DELAY_MS}
              max={MAX_EDITOR_AUTO_SAVE_DELAY_MS}
              step={250}
              value={autoSaveDelayDraft}
              onChange={(e) => setAutoSaveDelayDraft(e.target.value)}
              onBlur={commitAutoSaveDelay}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  commitAutoSaveDelay()
                }
              }}
              className="number-input-clean w-28 text-right tabular-nums"
            />
            <span className="text-xs text-muted-foreground">ms</span>
          </div>
        </SearchableSetting>

        <SearchableSetting
          title="Default Diff View"
          description="Preferred presentation format for showing git diffs by default."
          keywords={['diff', 'view', 'inline', 'side-by-side', 'split']}
          className="flex flex-col items-start gap-3 px-1 py-2 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="space-y-0.5">
            <Label>Default Diff View</Label>
            <p className="text-xs text-muted-foreground">
              Preferred presentation format for showing git diffs by default.
            </p>
          </div>
          <div className="flex shrink-0 items-center rounded-md border border-border/60 bg-background/50 p-0.5">
            {(['inline', 'side-by-side'] as const).map((option) => (
              <button
                key={option}
                onClick={() => updateSettings({ diffDefaultView: option })}
                className={`rounded-sm px-3 py-1 text-sm transition-colors ${
                  settings.diffDefaultView === option
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {option === 'inline' ? 'Inline' : 'Side-by-side'}
              </button>
            ))}
          </div>
        </SearchableSetting>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, GENERAL_CLI_SEARCH_ENTRIES) ? (
      <CliSection
        key="cli"
        currentPlatform={navigator.userAgent.includes('Mac') ? 'darwin' : 'other'}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, GENERAL_CACHE_TIMER_SEARCH_ENTRIES) ? (
      <section key="cache-timer" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Prompt Cache Timer</h3>
          <p className="text-xs text-muted-foreground">
            Claude caches your conversation to reduce costs. When idle too long the cache expires
            and the next message resends full context at higher cost. This shows a countdown so you
            know when to resume.
          </p>
        </div>

        <SearchableSetting
          title="Cache Timer"
          description="Show a countdown after a Claude agent becomes idle."
          keywords={['cache', 'timer', 'prompt', 'ttl', 'claude']}
          className="flex items-center justify-between gap-4 px-1 py-2"
        >
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <Timer className="size-4" />
              <Label>Cache Timer</Label>
            </div>
            <p className="text-xs text-muted-foreground">
              Show a countdown in the sidebar after a Claude agent becomes idle.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={settings.promptCacheTimerEnabled}
            aria-label="Cache Timer"
            onClick={() => {
              const enabling = !settings.promptCacheTimerEnabled
              updateSettings({ promptCacheTimerEnabled: enabling })
              // Why: if enabling mid-session, seed timers for any Claude tabs that
              // are already idle — their working→idle transition already happened
              // and won't re-fire.
              if (enabling) {
                useAppStore.getState().seedCacheTimersForIdleTabs()
              }
            }}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
              settings.promptCacheTimerEnabled ? 'bg-foreground' : 'bg-muted-foreground/30'
            }`}
          >
            <span
              className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                settings.promptCacheTimerEnabled ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </SearchableSetting>

        {settings.promptCacheTimerEnabled && (
          <SearchableSetting
            title="Timer Duration"
            description="Match this to your provider's cache TTL."
            keywords={['cache', 'timer', 'duration', 'ttl']}
            className="flex items-center justify-between gap-4 px-1 py-2 pl-7"
          >
            <div className="space-y-0.5">
              <Label>Timer Duration</Label>
              <p className="text-xs text-muted-foreground">
                Match this to your provider&apos;s cache TTL. The default is 5 minutes.
              </p>
            </div>
            <Select
              value={String(settings.promptCacheTtlMs)}
              onValueChange={(v) => updateSettings({ promptCacheTtlMs: Number(v) })}
            >
              <SelectTrigger size="sm" className="h-7 text-xs w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="300000">5 minutes</SelectItem>
                <SelectItem value="3600000">1 hour</SelectItem>
              </SelectContent>
            </Select>
          </SearchableSetting>
        )}
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, GENERAL_CODEX_ACCOUNTS_SEARCH_ENTRIES) ? (
      <section key="codex-accounts" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Codex Accounts</h3>
          <p className="text-xs text-muted-foreground">
            Add and switch between Codex accounts in Orca.
          </p>
          <p className="text-xs text-muted-foreground">
            Each account keeps its own local sign-in context in Orca. Account auth stays on this
            device.
          </p>
        </div>

        <SearchableSetting
          title="Codex Accounts"
          description="Manage which Codex account Orca uses for live rate limit fetching."
          keywords={['codex', 'account', 'rate limit', 'status bar', 'quota']}
          className="space-y-3 px-1 py-2"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <Label>Accounts</Label>
              <p className="text-xs text-muted-foreground">
                Add a Codex account to use it in Orca.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void runCodexAccountAction('adding', () => window.api.codexAccounts.add())
              }
              disabled={codexAction !== 'idle'}
              className="gap-2"
            >
              {codexAction === 'adding' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Plus className="size-3.5" />
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
                className={`flex min-h-[58px] w-full items-center justify-between gap-3 rounded-md border px-3 py-3 text-left transition-colors ${
                  codexAccounts.activeAccountId === null
                    ? 'border-foreground/25 bg-accent/20'
                    : 'border-border/70 hover:bg-accent/10'
                } disabled:cursor-default disabled:opacity-100`}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                  <span className="font-medium">System default</span>
                  <span className="truncate text-xs text-muted-foreground">
                    Use your current system Codex login.
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {codexAccounts.activeAccountId === null ? (
                    <span className="rounded-full bg-foreground px-2 py-0.5 text-[10px] font-medium text-background">
                      Active
                    </span>
                  ) : null}
                </div>
              </button>
              {codexAccounts.accounts.map((account) => {
                const isActive = codexAccounts.activeAccountId === account.id
                const isReauthing = codexAction === `reauth:${account.id}`
                const isRemoving = codexAction === `remove:${account.id}`
                const isBusy = codexAction !== 'idle'

                return (
                  <button
                    key={account.id}
                    type="button"
                    onClick={() =>
                      void runCodexAccountAction(`select:${account.id}`, () =>
                        window.api.codexAccounts.select({ accountId: account.id })
                      )
                    }
                    disabled={isBusy}
                    className={`flex min-h-[58px] w-full items-center justify-between gap-3 rounded-md border px-3 py-3 text-left transition-colors ${
                      isActive
                        ? 'border-foreground/25 bg-accent/20'
                        : 'border-border/70 hover:bg-accent/10'
                    }`}
                  >
                    <div className="flex w-full items-center justify-between gap-3 max-md:flex-col max-md:items-start">
                      <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                        <span className="truncate font-medium">{account.email}</span>
                        {account.workspaceLabel ? (
                          <span className="truncate text-xs text-muted-foreground">
                            {account.workspaceLabel}
                          </span>
                        ) : null}
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {formatAccountTimestamp(account.lastAuthenticatedAt)}
                        </span>
                        {isActive ? (
                          <span className="shrink-0 rounded-full bg-foreground px-2 py-0.5 text-[10px] font-medium text-background">
                            Active
                          </span>
                        ) : null}
                      </div>

                      <div className="flex shrink-0 items-center justify-end gap-2 max-md:w-full max-md:flex-wrap">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(event) => {
                            event.stopPropagation()
                            void runCodexAccountAction(`reauth:${account.id}`, () =>
                              window.api.codexAccounts.reauthenticate({ accountId: account.id })
                            )
                          }}
                          disabled={isBusy}
                          className="h-8 gap-2 px-3"
                        >
                          {isReauthing ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="size-3.5" />
                          )}
                          Re-authenticate
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(event) => {
                            event.stopPropagation()
                            setRemoveAccountId(account.id)
                          }}
                          disabled={isBusy}
                          className="h-8 gap-2 px-3"
                        >
                          {isRemoving ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="size-3.5" />
                          )}
                          Remove
                        </Button>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </SearchableSetting>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, GENERAL_UPDATE_SEARCH_ENTRIES) ? (
      <section key="updates" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Updates</h3>
          <p className="text-xs text-muted-foreground">Current version: {appVersion ?? '…'}</p>
        </div>

        <SearchableSetting
          title="Check for Updates"
          description="Check for app updates and install a newer Orca version."
          keywords={['update', 'version', 'release notes', 'download']}
          className="space-y-3"
        >
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.api.updater.check()}
              disabled={updateStatus.state === 'checking' || updateStatus.state === 'downloading'}
              className="gap-2"
            >
              {updateStatus.state === 'checking' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Check for Updates
            </Button>

            {updateStatus.state === 'available' ? (
              <Button
                variant="default"
                size="sm"
                onClick={() => window.api.updater.download()}
                className="gap-2"
              >
                <Download className="size-3.5" />
                Install Update ({updateStatus.version})
              </Button>
            ) : updateStatus.state === 'downloaded' ? (
              <Button variant="default" size="sm" onClick={handleRestartToUpdate} className="gap-2">
                <Download className="size-3.5" />
                Restart to Update ({updateStatus.version})
              </Button>
            ) : null}
          </div>

          <p className="text-xs text-muted-foreground">
            {updateStatus.state === 'idle' && 'Updates are checked automatically on launch.'}
            {updateStatus.state === 'checking' && 'Checking for updates...'}
            {updateStatus.state === 'available' && (
              <>
                Version {updateStatus.version} is available. Click &quot;Install Update&quot; to
                download and install it.{' '}
                <a
                  href={
                    updateStatus.releaseUrl ??
                    `https://github.com/stablyai/orca/releases/tag/v${updateStatus.version}`
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-foreground"
                >
                  Release notes
                </a>
              </>
            )}
            {updateStatus.state === 'not-available' && 'You\u2019re on the latest version.'}
            {updateStatus.state === 'downloading' &&
              `Downloading v${updateStatus.version}... ${updateStatus.percent}%`}
            {updateStatus.state === 'downloaded' && (
              <>
                Version {updateStatus.version} is ready to install.{' '}
                <a
                  href={
                    updateStatus.releaseUrl ??
                    `https://github.com/stablyai/orca/releases/tag/v${updateStatus.version}`
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-foreground"
                >
                  Release notes
                </a>
              </>
            )}
            {updateStatus.state === 'error' && `Update error: ${updateStatus.message}`}
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
      {visibleSections.map((section, index) => (
        <div key={index} className="space-y-8">
          {index > 0 ? <Separator /> : null}
          {section}
        </div>
      ))}
    </div>
  )
}
