import { useEffect, useState } from 'react'
import { RotateCw } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { useAppStore } from '../../store'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { EXPERIMENTAL_PANE_SEARCH_ENTRIES } from './experimental-search'

export { EXPERIMENTAL_PANE_SEARCH_ENTRIES }

type ExperimentalPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  /** Hidden-experimental group is only rendered once the user has unlocked
   *  it via Shift-clicking the Experimental sidebar entry. */
  hiddenExperimentalUnlocked?: boolean
}

export function ExperimentalPane({
  settings,
  updateSettings,
  hiddenExperimentalUnlocked = false
}: ExperimentalPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  // Why: "daemon enabled at startup" is the effective runtime state, read
  // directly from main once on mount. The banner compares the user's current
  // setting against this snapshot to tell them a restart is still required.
  // null = not yet fetched (banner stays hidden to avoid a flash).
  const [daemonEnabledAtStartup, setDaemonEnabledAtStartup] = useState<boolean | null>(null)
  const [relaunching, setRelaunching] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.api.app
      .getRuntimeFlags()
      .then((flags) => {
        if (!cancelled) {
          setDaemonEnabledAtStartup(flags.daemonEnabledAtStartup)
        }
      })
      .catch(() => {
        // Non-fatal; banner will just never show if the IPC is unavailable.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const showDaemon = matchesSettingsSearch(searchQuery, [EXPERIMENTAL_PANE_SEARCH_ENTRIES[0]])
  const showWorktreeSymlinks = matchesSettingsSearch(searchQuery, [
    EXPERIMENTAL_PANE_SEARCH_ENTRIES[1]
  ])
  const pendingRestart =
    daemonEnabledAtStartup !== null &&
    settings.experimentalTerminalDaemon !== daemonEnabledAtStartup

  const handleRelaunch = async (): Promise<void> => {
    if (relaunching) {
      return
    }
    setRelaunching(true)
    try {
      await window.api.app.relaunch()
    } catch {
      setRelaunching(false)
    }
  }

  return (
    <div className="space-y-4">
      {showDaemon ? (
        <SearchableSetting
          title="Persistent terminal sessions"
          description="Keeps terminal sessions alive across app restarts via a background daemon."
          keywords={[
            'experimental',
            'terminal',
            'daemon',
            'persistent',
            'background',
            'sessions',
            'restart',
            'reattach'
          ]}
          className="space-y-3 px-1 py-2"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-0.5">
              <Label>Persistent terminal sessions</Label>
              <p className="text-xs text-muted-foreground">
                Keeps terminals alive in a background daemon so they survive app restarts, with full
                scrollback. Experimental — some sessions may become unresponsive after internal
                state drift. Requires an app restart to take effect.
              </p>
            </div>
            <button
              role="switch"
              aria-checked={settings.experimentalTerminalDaemon}
              onClick={() =>
                updateSettings({
                  experimentalTerminalDaemon: !settings.experimentalTerminalDaemon
                })
              }
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                settings.experimentalTerminalDaemon ? 'bg-foreground' : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${
                  settings.experimentalTerminalDaemon ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          {pendingRestart ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-yellow-500/50 bg-yellow-500/10 px-3 py-2.5">
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-sm font-medium text-yellow-700 dark:text-yellow-300">
                  Restart required
                </p>
                <p className="text-xs text-muted-foreground">
                  {settings.experimentalTerminalDaemon
                    ? 'Restart Orca to start the background session daemon.'
                    : 'Restart Orca to stop the background session daemon. Any running background sessions will be closed.'}
                </p>
              </div>
              <Button
                size="sm"
                variant="default"
                className="shrink-0 gap-1.5"
                disabled={relaunching}
                onClick={handleRelaunch}
              >
                <RotateCw className={`size-3 ${relaunching ? 'animate-spin' : ''}`} />
                {relaunching ? 'Restarting…' : 'Restart now'}
              </Button>
            </div>
          ) : null}
        </SearchableSetting>
      ) : null}

      {showWorktreeSymlinks ? (
        <SearchableSetting
          title="Symlinks on worktrees"
          description="Automatically symlink configured files or folders into newly created worktrees."
          keywords={[
            'experimental',
            'worktree',
            'worktrees',
            'symlink',
            'symlinks',
            'link',
            'shared',
            'env',
            'node_modules'
          ]}
          className="space-y-3 px-1 py-2"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-0.5">
              <Label>Symlinks on worktrees</Label>
              <p className="text-xs text-muted-foreground">
                Allows for automatic symlinks of certain folders or files that must be connected to
                created worktrees.
              </p>
            </div>
            <button
              role="switch"
              aria-checked={settings.experimentalWorktreeSymlinks}
              onClick={() =>
                updateSettings({
                  experimentalWorktreeSymlinks: !settings.experimentalWorktreeSymlinks
                })
              }
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                settings.experimentalWorktreeSymlinks ? 'bg-foreground' : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${
                  settings.experimentalWorktreeSymlinks ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        </SearchableSetting>
      ) : null}

      {hiddenExperimentalUnlocked ? <HiddenExperimentalGroup /> : null}
    </div>
  )
}

// Why: anything in this group is deliberately unfinished or staff-only. The
// orange treatment (header tint, label colors) is the shared visual signal
// for hidden-experimental items so future entries inherit the same
// affordance without another round of styling decisions.
function HiddenExperimentalGroup(): React.JSX.Element {
  return (
    <section className="space-y-3 rounded-lg border border-orange-500/40 bg-orange-500/5 p-3">
      <div className="space-y-0.5">
        <h4 className="text-sm font-semibold text-orange-500 dark:text-orange-300">
          Hidden experimental
        </h4>
        <p className="text-xs text-orange-500/80 dark:text-orange-300/80">
          Unlisted toggles for internal testing. Nothing here is supported.
        </p>
      </div>

      <div className="flex items-start justify-between gap-4 rounded-md border border-orange-500/30 bg-orange-500/10 px-3 py-2.5">
        <div className="min-w-0 shrink space-y-0.5">
          <Label className="text-orange-600 dark:text-orange-300">Placeholder toggle</Label>
          <p className="text-xs text-orange-600/80 dark:text-orange-300/80">
            Does nothing today. Reserved as the first slot for hidden experimental options.
          </p>
        </div>
        <button
          type="button"
          aria-label="Placeholder toggle"
          className="relative inline-flex h-5 w-9 shrink-0 cursor-not-allowed items-center rounded-full border border-orange-500/40 bg-orange-500/20 opacity-70"
          disabled
        >
          <span className="inline-block h-3.5 w-3.5 translate-x-0.5 transform rounded-full bg-orange-200 shadow-sm dark:bg-orange-100" />
        </button>
      </div>
    </section>
  )
}
