/* eslint-disable max-lines -- Why: experimental settings stay in one pane so search filtering and hidden-section ordering remain local. */
import { useEffect, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { Label } from '../ui/label'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { FolderIcon, ShieldCheck } from 'lucide-react'
import { useAppStore } from '../../store'
import { toast } from 'sonner'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { EXPERIMENTAL_PANE_SEARCH_ENTRIES, EXPERIMENTAL_SEARCH_ENTRY } from './experimental-search'
import { HiddenExperimentalGroup } from './HiddenExperimentalGroup'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'

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
  const [massCodeVaultPathInput, setMassCodeVaultPathInput] = useState(
    settings.experimentalMassCodeVaultPath ?? ''
  )

  useEffect(() => {
    setMassCodeVaultPathInput(settings.experimentalMassCodeVaultPath ?? '')
  }, [settings.experimentalMassCodeVaultPath])

  const showPet = matchesSettingsSearch(searchQuery, [EXPERIMENTAL_SEARCH_ENTRY.pet])
  const showAgentsView = matchesSettingsSearch(searchQuery, [EXPERIMENTAL_SEARCH_ENTRY.activity])
  const showTerminalAttention = matchesSettingsSearch(searchQuery, [
    EXPERIMENTAL_SEARCH_ENTRY.terminalAttention
  ])
  const showCompactWorktreeCards = matchesSettingsSearch(searchQuery, [
    EXPERIMENTAL_SEARCH_ENTRY.compactWorktreeCards
  ])
  const showWorktreeSymlinks = matchesSettingsSearch(searchQuery, [
    EXPERIMENTAL_SEARCH_ENTRY.symlinks
  ])
  const showMasscode = matchesSettingsSearch(searchQuery, [EXPERIMENTAL_SEARCH_ENTRY.masscode])
  const showUnifiedNewTabLauncher = matchesSettingsSearch(searchQuery, [
    EXPERIMENTAL_SEARCH_ENTRY.unifiedNewTabLauncher
  ])

  const authorizeMassCodePath = async (vaultPath: string): Promise<boolean> => {
    const result = await window.api.app.authorizeMassCodeVault({ vaultPath })
    if (!result.ok) {
      toast.error(result.error)
      return false
    }
    toast.success(`Authorized massCode vault: ${result.vaultPath}`)
    updateSettings({
      experimentalMassCodeVaultPath: result.vaultPath,
      experimentalMassCode: true
    })
    return true
  }

  const toggleMassCode = async (enabled: boolean): Promise<void> => {
    if (!enabled) {
      updateSettings({ experimentalMassCode: false })
      return
    }

    if (settings.experimentalMassCodeVaultPath) {
      await authorizeMassCodePath(settings.experimentalMassCodeVaultPath)
      return
    }

    const detected = await window.api.app.detectMassCodeVault()
    if (detected.ok) {
      toast.success(`Detected massCode vault: ${detected.vaultPath}`)
      updateSettings({
        experimentalMassCode: true,
        experimentalMassCodeVaultPath: detected.vaultPath
      })
    } else {
      toast.error(detected.error)
      updateSettings({ experimentalMassCode: true })
    }
  }

  const authorizeTypedMassCodeVault = async (): Promise<void> => {
    await authorizeMassCodePath(massCodeVaultPathInput)
  }

  const pickMasscodeVault = async (): Promise<void> => {
    const selectedPath = await window.api.repos.pickDirectory()
    if (!selectedPath) {
      return
    }
    await authorizeMassCodePath(selectedPath)
  }

  const updateMassCodePreviewLines = (value: string): void => {
    const previewLines = Number(value)
    if (previewLines === 0 || previewLines === 1 || previewLines === 2) {
      updateSettings({ experimentalMassCodePreviewLines: previewLines })
    }
  }

  const updateMassCodeTriggerLocation = (value: string): void => {
    if (value === 'floating-button' || value === 'status-bar') {
      updateSettings({ massCodeTriggerLocation: value })
    }
  }

  const massCodePathControls = (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="min-w-0 shrink space-y-1.5">
        <Label>massCode Vault Path</Label>
        <p className="text-xs text-muted-foreground">
          The absolute path to your massCode Vault directory (v5+ Markdown format).
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={massCodeVaultPathInput}
          placeholder="~/massCode"
          onChange={(event) => setMassCodeVaultPathInput(event.target.value)}
          className="h-8"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void authorizeTypedMassCodeVault()}
          className="h-8 shrink-0 gap-1.5"
        >
          <ShieldCheck className="size-3.5" />
          Authorize
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          onClick={() => void pickMasscodeVault()}
          className="shrink-0"
          aria-label="Choose massCode vault"
        >
          <FolderIcon className="size-3.5" />
        </Button>
      </div>
      <div className="space-y-1.5 pt-1">
        <Label>Snippet Preview Lines</Label>
        <ToggleGroup
          type="single"
          value={String(settings.experimentalMassCodePreviewLines ?? 1)}
          onValueChange={(value) => {
            if (value) {
              updateMassCodePreviewLines(value)
            }
          }}
          className="justify-start"
        >
          <ToggleGroupItem value="0">None</ToggleGroupItem>
          <ToggleGroupItem value="1">1 line</ToggleGroupItem>
          <ToggleGroupItem value="2">2 lines</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div className="space-y-2 pt-1">
        <Label>Toggle Button Location</Label>
        <ToggleGroup
          type="single"
          value={settings.massCodeTriggerLocation ?? 'floating-button'}
          onValueChange={(value) => {
            if (value) {
              updateMassCodeTriggerLocation(value)
            }
          }}
          className="justify-start"
        >
          <ToggleGroupItem value="floating-button">Floating Button</ToggleGroupItem>
          <ToggleGroupItem value="status-bar">Status Bar</ToggleGroupItem>
        </ToggleGroup>
        <p className="text-xs text-muted-foreground">
          Choose where the massCode toggle icon is displayed.
        </p>
      </div>
      {!settings.experimentalMassCodeVaultPath ? (
        <p className="text-xs text-muted-foreground">
          The panel appears after a vault is authorized.
        </p>
      ) : null}
    </div>
  )

  return (
    <div className="space-y-4">
      {showMasscode ? (
        <SearchableSetting
          title="massCode Integration"
          description="Standalone snippet bridge for massCode (Markdown Vault)."
          keywords={EXPERIMENTAL_SEARCH_ENTRY.masscode.keywords}
          className="space-y-3 px-1 py-2"
        >
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 shrink space-y-1.5">
                <Label>massCode Integration</Label>
                <p className="text-xs text-muted-foreground">
                  Standalone snippet bridge for massCode (Markdown Vault). When enabled, a floating
                  massCode icon will appear in the bottom-right corner.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.experimentalMassCode}
                onClick={() => void toggleMassCode(!settings.experimentalMassCode)}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                  settings.experimentalMassCode ? 'bg-foreground' : 'bg-muted-foreground/30'
                }`}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${
                    settings.experimentalMassCode ? 'translate-x-4' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>

            {settings.experimentalMassCode ? massCodePathControls : null}
          </div>
        </SearchableSetting>
      ) : null}
      {showPet ? (
        <SearchableSetting
          title="Pet"
          description="Floating animated pet in the bottom-right corner."
          keywords={EXPERIMENTAL_SEARCH_ENTRY.pet.keywords}
          className="space-y-3 py-2"
          id="experimental-pet"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-1.5">
              <Label>Pet</Label>
              <p className="text-xs text-muted-foreground">
                Shows a small animated pet pinned to the bottom-right corner. Pick a character
                (Claudino, OpenCode, Gremlin) or upload your own PNG, APNG, GIF, WebP, JPG, or SVG
                from the status-bar pet menu. Hide it any time from the same menu without disabling
                this setting.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.experimentalPet}
              onClick={() => {
                updateSettings({ experimentalPet: !settings.experimentalPet })
              }}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                settings.experimentalPet ? 'bg-foreground' : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${
                  settings.experimentalPet ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        </SearchableSetting>
      ) : null}

      {showAgentsView ? (
        <SearchableSetting
          title="Agents View"
          description="Threaded left-sidebar feed for agent completions and blocking states."
          keywords={EXPERIMENTAL_SEARCH_ENTRY.activity.keywords}
          className="space-y-3 py-2"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-0.5">
              <Label>Agents View</Label>
              <p className="text-xs text-muted-foreground">
                Adds an Agents entry to the left sidebar with a threaded worktree feed for completed
                agents, blocking questions, unread state, and worktree creation events. Experimental
                — the event model and UI may change.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.experimentalActivity}
              onClick={() =>
                updateSettings({
                  experimentalActivity: !settings.experimentalActivity
                })
              }
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                settings.experimentalActivity ? 'bg-foreground' : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${
                  settings.experimentalActivity ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        </SearchableSetting>
      ) : null}

      {showTerminalAttention ? (
        <SearchableSetting
          title="Terminal attention"
          description="Persistent pane highlight for terminal bell and agent-completion events."
          keywords={EXPERIMENTAL_SEARCH_ENTRY.terminalAttention.keywords}
          className="space-y-3 py-2"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-0.5">
              <Label>Terminal attention</Label>
              <p className="text-xs text-muted-foreground">
                Keeps a pane-level highlight visible after terminal bell or agent-completion events
                until you interact with that pane. Experimental while we tune the signal.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.experimentalTerminalAttention}
              onClick={() =>
                updateSettings({
                  experimentalTerminalAttention: !settings.experimentalTerminalAttention
                })
              }
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                settings.experimentalTerminalAttention ? 'bg-foreground' : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${
                  settings.experimentalTerminalAttention ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        </SearchableSetting>
      ) : null}

      {showCompactWorktreeCards ? (
        <SearchableSetting
          title="Compact worktree cards"
          description="Hide redundant second lines in the worktree sidebar."
          keywords={EXPERIMENTAL_SEARCH_ENTRY.compactWorktreeCards.keywords}
          className="space-y-3 py-2"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-0.5">
              <Label>Compact worktree cards</Label>
              <p className="text-xs text-muted-foreground">
                Collapses a card only when its second line would be empty or repeat the title. Cards
                with a different branch, repo badge, folder badge, cache timer, or conflict state
                keep the second line.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.experimentalCompactWorktreeCards}
              onClick={() =>
                updateSettings({
                  experimentalCompactWorktreeCards: !settings.experimentalCompactWorktreeCards
                })
              }
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                settings.experimentalCompactWorktreeCards
                  ? 'bg-foreground'
                  : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${
                  settings.experimentalCompactWorktreeCards ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        </SearchableSetting>
      ) : null}

      {showWorktreeSymlinks ? (
        <SearchableSetting
          title="Symlinks on worktrees"
          description="Automatically symlink configured files or folders into newly created worktrees."
          keywords={EXPERIMENTAL_SEARCH_ENTRY.symlinks.keywords}
          className="space-y-3 py-2"
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

      {showUnifiedNewTabLauncher ? (
        <SearchableSetting
          title="Smart New Tab menu"
          description="Type in the New Tab menu to open a terminal, launch an agent, visit a URL, or open/create a file."
          keywords={EXPERIMENTAL_SEARCH_ENTRY.unifiedNewTabLauncher.keywords}
          className="space-y-3 py-2"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-0.5">
              <Label>Smart New Tab menu</Label>
              <p className="text-xs text-muted-foreground">
                Type in the New Tab menu to open a terminal, launch an agent, visit a URL, or
                open/create a file.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.experimentalUnifiedNewTabLauncher}
              onClick={() =>
                updateSettings({
                  experimentalUnifiedNewTabLauncher: !settings.experimentalUnifiedNewTabLauncher
                })
              }
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                settings.experimentalUnifiedNewTabLauncher
                  ? 'bg-foreground'
                  : 'bg-muted-foreground/30'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${
                  settings.experimentalUnifiedNewTabLauncher ? 'translate-x-4' : 'translate-x-0.5'
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
