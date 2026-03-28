import { useEffect, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { Download, FolderOpen, Loader2, RefreshCw } from 'lucide-react'
import { useAppStore } from '../../store'

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
  const updateStatus = useAppStore((s) => s.updateStatus)
  const [appVersion, setAppVersion] = useState<string | null>(null)

  useEffect(() => {
    window.api.updater.getVersion().then(setAppVersion)
  }, [])

  const handleBrowseWorkspace = async () => {
    const path = await window.api.repos.pickFolder()
    if (path) {
      updateSettings({ workspaceDir: path })
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Workspace</h2>
          <p className="text-xs text-muted-foreground">
            Configure where new worktrees are created.
          </p>
        </div>

        <div className="space-y-2">
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
        </div>

        <div className="flex items-center justify-between gap-4 px-1 py-2">
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
        </div>
      </section>

      <Separator />

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Branch Naming</h2>
          <p className="text-xs text-muted-foreground">
            Prefix added to branch names when creating worktrees.
          </p>
        </div>

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
              {option === 'git-username' ? 'Git Username' : option === 'custom' ? 'Custom' : 'None'}
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
      </section>

      <Separator />

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Updates</h2>
          <p className="text-xs text-muted-foreground">Current version: {appVersion ?? '…'}</p>
        </div>

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
            <Button
              variant="default"
              size="sm"
              onClick={() => window.api.updater.quitAndInstall()}
              className="gap-2"
            >
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
              download.{' '}
              <a
                href={`https://github.com/stablyai/orca/releases/tag/v${updateStatus.version}`}
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
                href={`https://github.com/stablyai/orca/releases/tag/v${updateStatus.version}`}
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
      </section>
    </div>
  )
}
