/* eslint-disable max-lines -- Why: GeneralPane is the single owner of all general settings UI;
   splitting individual settings into separate files would scatter related controls without a
   meaningful abstraction boundary. */
import { useEffect, useState } from 'react'
import type {
  CodexRateLimitAccountsState,
  GlobalSettings,
  OpenCodeAccountsState
} from '../../../../shared/types'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { Download, FolderOpen, Import, Loader2, Plus, RefreshCw, Timer, Trash2 } from 'lucide-react'
import { useAppStore } from '../../store'
import { CliSection } from './CliSection'
import { toast } from 'sonner'
import {
  DEFAULT_EDITOR_AUTO_SAVE_DELAY_MS,
  MAX_EDITOR_AUTO_SAVE_DELAY_MS,
  MIN_EDITOR_AUTO_SAVE_DELAY_MS,
  ORCA_BROWSER_BLANK_URL
} from '../../../../shared/constants'
import { normalizeBrowserNavigationUrl } from '../../../../shared/browser-url'
import { clampNumber } from '@/lib/terminal-theme'
import {
  GENERAL_BROWSER_SEARCH_ENTRIES,
  GENERAL_CODEX_ACCOUNTS_SEARCH_ENTRIES,
  GENERAL_CACHE_TIMER_SEARCH_ENTRIES,
  GENERAL_CLI_SEARCH_ENTRIES,
  GENERAL_EDITOR_SEARCH_ENTRIES,
  GENERAL_OPENCODE_ACCOUNTS_SEARCH_ENTRIES,
  GENERAL_PANE_SEARCH_ENTRIES,
  GENERAL_UPDATE_SEARCH_ENTRIES,
  GENERAL_WORKSPACE_SEARCH_ENTRIES
} from './general-search'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
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

function getOpenCodeAccountErrorDescription(error: unknown): string {
  return (
    String((error as Error)?.message ?? error)
      .replace(/^Error occurred in handler for 'openCodeAccounts:[^']+':\s*/i, '')
      .replace(/^Error invoking remote method 'openCodeAccounts:[^']+':\s*/i, '')
      .replace(/^Error:\s*/i, '')
      .trim() || 'OpenCode account update failed. Please try again.'
  )
}

export function GeneralPane({ settings, updateSettings }: GeneralPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  const updateStatus = useAppStore((s) => s.updateStatus)
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const browserDefaultUrl = useAppStore((s) => s.browserDefaultUrl)
  const setBrowserDefaultUrl = useAppStore((s) => s.setBrowserDefaultUrl)
  const detectedBrowsers = useAppStore((s) => s.detectedBrowsers)
  const browserSessionProfiles = useAppStore((s) => s.browserSessionProfiles)
  const browserSessionImportState = useAppStore((s) => s.browserSessionImportState)
  const defaultProfile = browserSessionProfiles.find((p) => p.id === 'default')
  const orphanedProfiles = browserSessionProfiles.filter((p) => p.scope !== 'default')
  const [homePageDraft, setHomePageDraft] = useState(browserDefaultUrl ?? '')
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [autoSaveDelayDraft, setAutoSaveDelayDraft] = useState(
    String(settings.editorAutoSaveDelayMs)
  )
  const [codexAccounts, setCodexAccounts] = useState<CodexRateLimitAccountsState>({
    accounts: [],
    activeAccountId: null
  })
  const [openCodeAccounts, setOpenCodeAccounts] = useState<OpenCodeAccountsState>({
    accounts: [],
    activeAccountId: null
  })
  const [codexAction, setCodexAction] = useState<
    'idle' | 'adding' | `reauth:${string}` | `remove:${string}` | `select:${string | 'system'}`
  >('idle')
  const [openCodeAction, setOpenCodeAction] = useState<
    'idle' | `save:${'add' | string}` | `remove:${string}` | `select:${string | 'system'}`
  >('idle')
  const [removeAccountId, setRemoveAccountId] = useState<string | null>(null)
  const [removeOpenCodeAccountId, setRemoveOpenCodeAccountId] = useState<string | null>(null)
  const [openCodeDialogAccountId, setOpenCodeDialogAccountId] = useState<string | 'add' | null>(
    null
  )
  const [openCodeLabelDraft, setOpenCodeLabelDraft] = useState('')
  const [openCodeApiKeyDraft, setOpenCodeApiKeyDraft] = useState('')

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

  useEffect(() => {
    let stale = false

    const loadOpenCodeAccounts = async (): Promise<void> => {
      try {
        const next = await window.api.openCodeAccounts.list()
        if (!stale) {
          setOpenCodeAccounts(next)
        }
      } catch (error) {
        if (!stale) {
          toast.error('Could not load OpenCode accounts.', {
            description: String((error as Error)?.message ?? error)
          })
        }
      }
    }

    void loadOpenCodeAccounts()

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
    // Why: quitAndInstall resolves immediately (the actual quit happens in a
    // deferred timer in the main process), so rejection here is only possible
    // if the IPC channel itself breaks. Log defensively; the user will notice
    // the app didn't restart and can retry.
    void window.api.updater.quitAndInstall().catch(console.error)
  }

  const syncCodexAccounts = async (next: CodexRateLimitAccountsState): Promise<void> => {
    setCodexAccounts(next)
    await fetchSettings()
  }

  const syncOpenCodeAccounts = async (next: OpenCodeAccountsState): Promise<void> => {
    setOpenCodeAccounts(next)
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

  const runOpenCodeAccountAction = async (
    action: typeof openCodeAction,
    operation: () => Promise<OpenCodeAccountsState>
  ): Promise<void> => {
    setOpenCodeAction(action)
    try {
      const next = await operation()
      await syncOpenCodeAccounts(next)
    } catch (error) {
      toast.error('OpenCode account update failed.', {
        description: getOpenCodeAccountErrorDescription(error)
      })
    } finally {
      setOpenCodeAction('idle')
    }
  }

  const selectedOpenCodeDialogAccount =
    openCodeDialogAccountId && openCodeDialogAccountId !== 'add'
      ? (openCodeAccounts.accounts.find((account) => account.id === openCodeDialogAccountId) ??
        null)
      : null
  const openCodeDialogMode = openCodeDialogAccountId === 'add' ? 'add' : 'reauth'

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
            Control how Orca handles links and browser workspace defaults.
          </p>
        </div>

        <SearchableSetting
          title="Default Home Page"
          description="URL opened when creating a new browser tab. Leave empty to open a blank tab."
          keywords={['browser', 'home', 'homepage', 'default', 'url', 'new tab', 'blank']}
          className="flex items-start justify-between gap-4 px-1 py-2"
        >
          <div className="min-w-0 shrink space-y-0.5">
            <Label>Default Home Page</Label>
            <p className="text-xs text-muted-foreground">
              URL opened when creating a new browser tab. Leave empty to open a blank tab.
            </p>
          </div>
          <form
            className="flex shrink-0 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              const trimmed = homePageDraft.trim()
              if (!trimmed) {
                setBrowserDefaultUrl(null)
                return
              }
              const normalized = normalizeBrowserNavigationUrl(trimmed)
              if (normalized && normalized !== ORCA_BROWSER_BLANK_URL) {
                setBrowserDefaultUrl(normalized)
                setHomePageDraft(normalized)
                toast.success('Home page saved.')
              }
            }}
          >
            <Input
              value={homePageDraft}
              onChange={(e) => setHomePageDraft(e.target.value)}
              placeholder="https://google.com"
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              className="h-7 w-52 text-xs"
            />
            <Button type="submit" size="sm" variant="outline" className="h-7 text-xs">
              Save
            </Button>
          </form>
        </SearchableSetting>

        <SearchableSetting
          title="Terminal Link Routing"
          description="Cmd/Ctrl+click opens terminal http(s) links in Orca. Shift+Cmd/Ctrl+click uses the system browser."
          keywords={['browser', 'preview', 'links', 'localhost', 'webview']}
          className="flex items-center justify-between gap-4 px-1 py-2"
        >
          <div className="space-y-0.5">
            <Label>Terminal Link Routing</Label>
            <p className="text-xs text-muted-foreground">
              Cmd/Ctrl+click opens terminal links in Orca. Shift+Cmd/Ctrl+click opens the same link
              in your system browser.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={settings.openLinksInApp}
            onClick={() => updateSettings({ openLinksInApp: !settings.openLinksInApp })}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
              settings.openLinksInApp ? 'bg-foreground' : 'bg-muted-foreground/30'
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${
                settings.openLinksInApp ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </SearchableSetting>

        <SearchableSetting
          title="Session & Cookies"
          description="Import cookies from Chrome, Edge, or other browsers to use existing logins inside Orca."
          keywords={[
            'cookies',
            'session',
            'import',
            'auth',
            'login',
            'chrome',
            'edge',
            'arc',
            'profile'
          ]}
          className="space-y-3 px-1 py-2"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <Label>Session &amp; Cookies</Label>
              <p className="text-xs text-muted-foreground">
                Import cookies from your system browser to reuse existing logins inside Orca.
              </p>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="xs"
                  className="shrink-0 gap-1.5"
                  disabled={browserSessionImportState?.status === 'importing'}
                >
                  {browserSessionImportState?.status === 'importing' ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Import className="size-3" />
                  )}
                  Import Cookies
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {detectedBrowsers.map((browser) => (
                  <DropdownMenuItem
                    key={browser.family}
                    onSelect={async () => {
                      const store = useAppStore.getState()
                      const result = await store.importCookiesFromBrowser('default', browser.family)
                      if (result.ok) {
                        toast.success(
                          `Imported ${result.summary.importedCookies} cookies from ${browser.label}.`
                        )
                      } else {
                        toast.error(result.reason)
                      }
                    }}
                  >
                    From {browser.label}
                  </DropdownMenuItem>
                ))}
                {detectedBrowsers.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  onSelect={async () => {
                    const store = useAppStore.getState()
                    const result = await store.importCookiesToProfile('default')
                    if (result.ok) {
                      toast.success(`Imported ${result.summary.importedCookies} cookies from file.`)
                    } else if (result.reason !== 'canceled') {
                      toast.error(result.reason)
                    }
                  }}
                >
                  From File…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {defaultProfile?.source ? (
            <div className="flex w-full items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2.5">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-medium">
                  Imported from {defaultProfile.source.browserFamily}
                  {defaultProfile.source.profileName
                    ? ` (${defaultProfile.source.profileName})`
                    : ''}
                </span>
                {defaultProfile.source.importedAt ? (
                  <span className="truncate text-[11px] text-muted-foreground">
                    {new Date(defaultProfile.source.importedAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit'
                    })}
                  </span>
                ) : null}
              </div>
              <Button
                variant="ghost"
                size="xs"
                className="gap-1 text-muted-foreground hover:text-destructive"
                onClick={async () => {
                  const ok = await useAppStore.getState().clearDefaultSessionCookies()
                  if (ok) {
                    toast.success('Cookies cleared.')
                  }
                }}
              >
                <Trash2 className="size-3" />
                Clear
              </Button>
            </div>
          ) : null}

          {orphanedProfiles.length > 0 ? (
            <div className="space-y-2">
              {orphanedProfiles.map((profile) => (
                <div
                  key={profile.id}
                  className="flex w-full items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2.5"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium">{profile.label}</span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {profile.source
                        ? `Imported from ${profile.source.browserFamily}${profile.source.profileName ? ` (${profile.source.profileName})` : ''}`
                        : 'Unused session'}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="gap-1 text-muted-foreground hover:text-destructive"
                    onClick={async () => {
                      const ok = await useAppStore
                        .getState()
                        .deleteBrowserSessionProfile(profile.id)
                      if (ok) {
                        toast.success('Session removed.')
                      }
                    }}
                  >
                    <Trash2 className="size-3" />
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
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
      <section key="codex-accounts" id="general-codex-accounts" className="space-y-4 scroll-mt-6">
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
          {/* Why: Settings deep-links can target this subsection directly from
          the status-bar account switcher. Keeping a stable DOM anchor here
          avoids dumping the user at the top of General and making them hunt
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
                  <button
                    key={account.id}
                    type="button"
                    onClick={() =>
                      void runCodexAccountAction(`select:${account.id}`, () =>
                        window.api.codexAccounts.select({ accountId: account.id })
                      )
                    }
                    disabled={isBusy}
                    className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
                      isActive
                        ? 'border-foreground/20 bg-accent/15'
                        : 'border-border/70 hover:border-border hover:bg-accent/8'
                    }`}
                  >
                    <div className="flex w-full items-center justify-between gap-3 max-md:flex-col max-md:items-start">
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
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
                      </div>

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
                  </button>
                )
              })}
            </div>
          )}
        </SearchableSetting>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, GENERAL_OPENCODE_ACCOUNTS_SEARCH_ENTRIES) ? (
      <section
        key="opencode-accounts"
        id="general-opencode-accounts"
        className="space-y-4 scroll-mt-6"
      >
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">OpenCode Accounts</h3>
          <p className="text-xs text-muted-foreground">
            Add and switch between OpenCode Go credentials in Orca.
          </p>
          <p className="text-xs text-muted-foreground">
            Orca stores managed OpenCode Go API keys in its local app data and injects the selected
            one only into new Orca terminals.
          </p>
        </div>

        <SearchableSetting
          title="OpenCode Accounts"
          description="Manage which OpenCode Go credential Orca uses for new terminal sessions."
          keywords={['opencode', 'open code', 'account', 'api key', 'credential', 'switch']}
          className="space-y-3 px-1 py-2"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <Label>Accounts</Label>
              <p className="text-xs text-muted-foreground">
                Add an OpenCode Go API key for Orca-managed switching.
              </p>
            </div>
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                setOpenCodeDialogAccountId('add')
                setOpenCodeLabelDraft('')
                setOpenCodeApiKeyDraft('')
              }}
              disabled={openCodeAction !== 'idle'}
              className="gap-1.5"
            >
              <Plus className="size-3" />
              Add Account
            </Button>
          </div>

          {openCodeAccounts.accounts.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/70 px-3 py-4 text-xs text-muted-foreground">
              No managed OpenCode accounts yet. Orca will keep using your system default OpenCode
              credential until you add one here.
            </div>
          ) : (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() =>
                  void runOpenCodeAccountAction('select:system', () =>
                    window.api.openCodeAccounts.select({ accountId: null })
                  )
                }
                disabled={openCodeAction !== 'idle'}
                className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
                  openCodeAccounts.activeAccountId === null
                    ? 'border-foreground/20 bg-accent/15'
                    : 'border-border/70 hover:border-border hover:bg-accent/8'
                } disabled:cursor-default disabled:opacity-100`}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium">System default</span>
                    {openCodeAccounts.activeAccountId === null ? (
                      <Badge
                        variant="outline"
                        className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none text-foreground/80"
                      >
                        Active
                      </Badge>
                    ) : null}
                  </div>
                  <span className="truncate text-[11px] text-muted-foreground">
                    Use your current system OpenCode credential.
                  </span>
                </div>
              </button>
              {openCodeAccounts.accounts.map((account) => {
                const isActive = openCodeAccounts.activeAccountId === account.id
                const isSaving = openCodeAction === `save:${account.id}`
                const isRemoving = openCodeAction === `remove:${account.id}`
                const isBusy = openCodeAction !== 'idle'

                return (
                  <button
                    key={account.id}
                    type="button"
                    onClick={() =>
                      void runOpenCodeAccountAction(`select:${account.id}`, () =>
                        window.api.openCodeAccounts.select({ accountId: account.id })
                      )
                    }
                    disabled={isBusy}
                    className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
                      isActive
                        ? 'border-foreground/20 bg-accent/15'
                        : 'border-border/70 hover:border-border hover:bg-accent/8'
                    }`}
                  >
                    <div className="flex w-full items-center justify-between gap-3 max-md:flex-col max-md:items-start">
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium">{account.label}</span>
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
                          <span className="shrink-0">OpenCode Go</span>
                          <span className="shrink-0 opacity-50">•</span>
                          <span className="shrink-0">{account.keyHint}</span>
                          <span className="shrink-0 opacity-50">•</span>
                          <span className="shrink-0">
                            {formatAccountTimestamp(account.lastAuthenticatedAt)}
                          </span>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center justify-end gap-1 max-md:w-full max-md:flex-wrap">
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={(event) => {
                            event.stopPropagation()
                            setOpenCodeDialogAccountId(account.id)
                            setOpenCodeLabelDraft(account.label)
                            setOpenCodeApiKeyDraft('')
                          }}
                          disabled={isBusy}
                          className="h-6 px-2 text-muted-foreground hover:text-foreground"
                        >
                          {isSaving ? (
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
                            setRemoveOpenCodeAccountId(account.id)
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
                onClick={() => {
                  void window.api.updater.download().catch((error) => {
                    toast.error('Could not start the update download.', {
                      description: String((error as Error)?.message ?? error)
                    })
                  })
                }}
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
        open={openCodeDialogAccountId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setOpenCodeDialogAccountId(null)
            setOpenCodeLabelDraft('')
            setOpenCodeApiKeyDraft('')
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {openCodeDialogMode === 'add'
                ? 'Add OpenCode Account'
                : 'Re-authenticate OpenCode Account'}
            </DialogTitle>
            <DialogDescription>
              {openCodeDialogMode === 'add'
                ? 'Save an OpenCode Go API key in Orca so you can switch accounts without changing your system credential.'
                : 'Update the stored OpenCode Go API key for this Orca-managed account.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="opencode-account-label">Label</Label>
              <Input
                id="opencode-account-label"
                value={openCodeLabelDraft}
                onChange={(event) => setOpenCodeLabelDraft(event.target.value)}
                placeholder="Work account"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="opencode-account-api-key">OpenCode Go API Key</Label>
              <Input
                id="opencode-account-api-key"
                type="password"
                value={openCodeApiKeyDraft}
                onChange={(event) => setOpenCodeApiKeyDraft(event.target.value)}
                placeholder={
                  openCodeDialogMode === 'add'
                    ? 'sk-...'
                    : `Enter a new API key for ${selectedOpenCodeDialogAccount?.label ?? 'this account'}`
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setOpenCodeDialogAccountId(null)
                setOpenCodeLabelDraft('')
                setOpenCodeApiKeyDraft('')
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                const label = openCodeLabelDraft.trim()
                const apiKey = openCodeApiKeyDraft.trim()
                if (!label || !apiKey) {
                  toast.error('OpenCode account details are incomplete.', {
                    description: 'Both a label and an OpenCode Go API key are required.'
                  })
                  return
                }

                const dialogAccountId = openCodeDialogAccountId
                setOpenCodeDialogAccountId(null)
                setOpenCodeLabelDraft('')
                setOpenCodeApiKeyDraft('')

                if (dialogAccountId === 'add') {
                  void runOpenCodeAccountAction('save:add', () =>
                    window.api.openCodeAccounts.add({ label, apiKey })
                  )
                  return
                }

                if (!dialogAccountId) {
                  return
                }

                void runOpenCodeAccountAction(`save:${dialogAccountId}`, () =>
                  window.api.openCodeAccounts.reauthenticate({
                    accountId: dialogAccountId,
                    label,
                    apiKey
                  })
                )
              }}
            >
              {openCodeDialogMode === 'add' ? 'Add Account' : 'Save API Key'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
        open={removeOpenCodeAccountId !== null}
        onOpenChange={(open) => !open && setRemoveOpenCodeAccountId(null)}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Remove OpenCode Account?</DialogTitle>
            <DialogDescription>
              Orca will delete the managed OpenCode credential for this saved account. If it is
              currently active, Orca falls back to the system default OpenCode credential.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveOpenCodeAccountId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const accountId = removeOpenCodeAccountId
                if (!accountId) {
                  return
                }
                setRemoveOpenCodeAccountId(null)
                void runOpenCodeAccountAction(`remove:${accountId}`, () =>
                  window.api.openCodeAccounts.remove({ accountId })
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
