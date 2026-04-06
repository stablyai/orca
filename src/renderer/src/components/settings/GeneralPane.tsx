/* eslint-disable max-lines -- Why: GeneralPane is the single owner of all general settings UI;
   splitting individual settings into separate files would scatter related controls without a
   meaningful abstraction boundary. */
import { useEffect, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { Download, FolderOpen, Loader2, RefreshCw } from 'lucide-react'
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
  GENERAL_BRANCH_SEARCH_ENTRIES,
  GENERAL_CLI_SEARCH_ENTRIES,
  GENERAL_EDITOR_SEARCH_ENTRIES,
  GENERAL_PANE_SEARCH_ENTRIES,
  GENERAL_UPDATE_SEARCH_ENTRIES,
  GENERAL_WORKSPACE_SEARCH_ENTRIES
} from './general-search'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'

export { GENERAL_PANE_SEARCH_ENTRIES }

type GeneralPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  displayedGitUsername: string
}

export function GeneralPane({
  settings,
  updateSettings,
  displayedGitUsername
}: GeneralPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  const updateStatus = useAppStore((s) => s.updateStatus)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [autoSaveDelayDraft, setAutoSaveDelayDraft] = useState(
    String(settings.editorAutoSaveDelayMs)
  )

  useEffect(() => {
    window.api.updater.getVersion().then(setAppVersion)
  }, [])

  useEffect(() => {
    setAutoSaveDelayDraft(String(settings.editorAutoSaveDelayMs))
  }, [settings.editorAutoSaveDelayMs])

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
    matchesSettingsSearch(searchQuery, GENERAL_BRANCH_SEARCH_ENTRIES) ? (
      <section key="branch-prefix" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Branch Naming</h3>
          <p className="text-xs text-muted-foreground">
            Prefix added to branch names when creating worktrees.
          </p>
        </div>

        <SearchableSetting
          title="Branch Prefix"
          description="Prefix added to branch names when creating worktrees."
          keywords={['branch naming', 'git username', 'custom']}
          className="space-y-3"
        >
          <div className="flex w-fit gap-1 rounded-md border border-border/50 p-1">
            {(['git-username', 'custom', 'none'] as const).map((option) => (
              <button
                key={option}
                onClick={() => updateSettings({ branchPrefix: option })}
                className={`rounded-sm px-3 py-1 text-sm transition-colors ${
                  settings.branchPrefix === option
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {option === 'git-username'
                  ? 'Git Username'
                  : option === 'custom'
                    ? 'Custom'
                    : 'None'}
              </button>
            ))}
          </div>
          {(settings.branchPrefix === 'custom' || settings.branchPrefix === 'git-username') && (
            <Input
              value={
                settings.branchPrefix === 'git-username'
                  ? displayedGitUsername
                  : settings.branchPrefixCustom
              }
              onChange={(e) => updateSettings({ branchPrefixCustom: e.target.value })}
              placeholder={
                settings.branchPrefix === 'git-username'
                  ? 'No git username configured'
                  : 'e.g. feature'
              }
              className="max-w-xs"
              readOnly={settings.branchPrefix === 'git-username'}
            />
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
                {updateStatus.manualDownloadUrl
                  ? `Download Update (${updateStatus.version})`
                  : `Install Update (${updateStatus.version})`}
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
                Version {updateStatus.version} is available.{' '}
                {updateStatus.manualDownloadUrl
                  ? 'Open the download to install it manually.'
                  : 'Click "Install Update" to download it.'}{' '}
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
      {visibleSections.map((section, index) => (
        <div key={index} className="space-y-8">
          {index > 0 ? <Separator /> : null}
          {section}
        </div>
      ))}
    </div>
  )
}
