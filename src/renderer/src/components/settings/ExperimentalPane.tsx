import { useState } from 'react'
import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { useAppStore } from '../../store'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { EXPERIMENTAL_PANE_SEARCH_ENTRIES, EXPERIMENTAL_SEARCH_ENTRY } from './experimental-search'
import { MobilePane } from './MobilePane'
import { HiddenExperimentalGroup } from './HiddenExperimentalGroup'

export { EXPERIMENTAL_PANE_SEARCH_ENTRIES }

const ORCHESTRATION_SKILL_INSTALL_COMMAND =
  'npx skills add https://github.com/stablyai/orca --skill orchestration'

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
  const showMobile = matchesSettingsSearch(searchQuery, [EXPERIMENTAL_SEARCH_ENTRY.mobile])
  const showSidekick = matchesSettingsSearch(searchQuery, [EXPERIMENTAL_SEARCH_ENTRY.sidekick])
  const showOrchestration = matchesSettingsSearch(searchQuery, [
    EXPERIMENTAL_SEARCH_ENTRY.orchestration
  ])
  const showWorktreeSymlinks = matchesSettingsSearch(searchQuery, [
    EXPERIMENTAL_SEARCH_ENTRY.symlinks
  ])

  const [orchestrationEnabled, setOrchestrationEnabled] = useState<boolean>(() => {
    return localStorage.getItem('orca.orchestration.enabled') === '1'
  })

  const [orchestrationSkillInstalled, setOrchestrationSkillInstalled] = useState<boolean>(() => {
    return localStorage.getItem('orca.orchestration.skillInstalled') === '1'
  })

  const toggleOrchestration = (value: boolean): void => {
    setOrchestrationEnabled(value)
    localStorage.setItem('orca.orchestration.enabled', value ? '1' : '0')
  }

  const markOrchestrationSkillInstalled = (value: boolean): void => {
    setOrchestrationSkillInstalled(value)
    localStorage.setItem('orca.orchestration.skillInstalled', value ? '1' : '0')
  }

  const handleCopyOrchestrationCommand = async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(ORCHESTRATION_SKILL_INSTALL_COMMAND)
      toast.success('Copied install command. Run it in your agent project.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to copy command.')
    }
  }

  return (
    <div className="space-y-4">
      {showMobile ? (
        <SearchableSetting
          title="Mobile Pairing"
          description="Pair a mobile device to control Orca remotely."
          keywords={EXPERIMENTAL_SEARCH_ENTRY.mobile.keywords}
          className="space-y-3 px-1 py-2"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-1.5">
              <Label>Mobile Pairing</Label>
              <p className="text-xs text-muted-foreground">
                Control Orca from your phone by scanning a QR code. Beta / early preview &mdash;
                expect bugs and breaking changes. Get started from the{' '}
                <button
                  type="button"
                  // Why: points at the current mobile release tag rather than
                  // the generic /releases page, which is dominated by desktop
                  // releases and forces the user to scroll. Update this URL
                  // when cutting a new mobile-v* tag.
                  onClick={() =>
                    void window.api.shell.openUrl(
                      'https://github.com/stablyai/orca/releases/tag/mobile-v0.0.2'
                    )
                  }
                  className="cursor-pointer underline underline-offset-2 hover:text-foreground"
                >
                  GitHub Releases page
                </button>
                .
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.experimentalMobile}
              onClick={() =>
                updateSettings({
                  experimentalMobile: !settings.experimentalMobile
                })
              }
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                settings.experimentalMobile ? 'bg-foreground' : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${
                  settings.experimentalMobile ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          {settings.experimentalMobile ? (
            <div className="rounded-xl border border-border/60 bg-card/50 p-4">
              <MobilePane />
            </div>
          ) : null}
        </SearchableSetting>
      ) : null}

      {showSidekick ? (
        <SearchableSetting
          title="Sidekick"
          description="Floating animated sidekick in the bottom-right corner."
          keywords={EXPERIMENTAL_SEARCH_ENTRY.sidekick.keywords}
          className="space-y-3 px-1 py-2"
          id="experimental-sidekick"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-1.5">
              <Label>Sidekick</Label>
              <p className="text-xs text-muted-foreground">
                Shows a small animated sidekick pinned to the bottom-right corner. Pick a character
                (Claudino, OpenCode, Gremlin) or upload your own PNG, APNG, GIF, WebP, JPG, or SVG
                from the status-bar sidekick menu. Hide it any time from the same menu without
                disabling this setting.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.experimentalSidekick}
              onClick={() => {
                updateSettings({ experimentalSidekick: !settings.experimentalSidekick })
              }}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                settings.experimentalSidekick ? 'bg-foreground' : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${
                  settings.experimentalSidekick ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        </SearchableSetting>
      ) : null}

      {showOrchestration ? (
        <SearchableSetting
          title="Agent Orchestration"
          description="Coordinate multiple coding agents via messaging, task DAGs, dispatch, and decision gates."
          keywords={EXPERIMENTAL_SEARCH_ENTRY.orchestration.keywords}
          className="space-y-3 px-1 py-2"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-0.5">
              <Label>Agent Orchestration</Label>
              <p className="text-xs text-muted-foreground">
                Coordinate multiple coding agents with messaging, task DAGs, dispatch with preamble
                injection, decision gates, and coordinator loops. Experimental — APIs may change.
              </p>
            </div>
            <button
              role="switch"
              aria-checked={orchestrationEnabled}
              onClick={() => toggleOrchestration(!orchestrationEnabled)}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                orchestrationEnabled ? 'bg-foreground' : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${
                  orchestrationEnabled ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>

          {orchestrationEnabled ? (
            <div className="space-y-3 rounded-xl border border-border/60 bg-card/50 p-4">
              <div className="space-y-1">
                <p className="text-sm font-medium">Install Orchestration Skill</p>
                <p className="text-xs text-muted-foreground">
                  Run this in your agent project so agents learn to use inter-agent orchestration
                  commands.
                </p>
              </div>
              <div className="flex max-w-full items-center gap-2 rounded-lg border border-border/60 bg-background/60 px-3 py-2">
                <code className="flex-1 overflow-x-auto whitespace-nowrap text-[11px] text-muted-foreground">
                  {ORCHESTRATION_SKILL_INSTALL_COMMAND}
                </code>
                <TooltipProvider delayDuration={250}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => void handleCopyOrchestrationCommand()}
                        aria-label="Copy orchestration skill install command"
                      >
                        <Copy className="size-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>
                      Copy
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span>
                  {orchestrationSkillInstalled
                    ? 'Marked as installed on this machine.'
                    : "Check off once you've run it in your project."}
                </span>
                <button
                  type="button"
                  className="underline-offset-2 hover:text-foreground hover:underline"
                  onClick={() => markOrchestrationSkillInstalled(!orchestrationSkillInstalled)}
                >
                  {orchestrationSkillInstalled ? 'Undo' : 'I ran it'}
                </button>
              </div>
            </div>
          ) : null}
        </SearchableSetting>
      ) : null}

      {showWorktreeSymlinks ? (
        <SearchableSetting
          title="Symlinks on worktrees"
          description="Automatically symlink configured files or folders into newly created worktrees."
          keywords={EXPERIMENTAL_SEARCH_ENTRY.symlinks.keywords}
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
              type="button"
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
