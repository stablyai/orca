import { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import type { FloatingTerminalTriggerLocation, GlobalSettings } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { SearchableSetting } from './SearchableSetting'
import { FLOATING_WORKSPACE_SEARCH_ENTRIES } from './floating-workspace-search'
import { matchesSettingsSearch } from './settings-search'
import { useAppStore } from '../../store'

type FloatingWorkspacePaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function getFloatingWorkspaceDirectoryInputValue({
  resolvedFloatingWorkspacePath
}: {
  resolvedFloatingWorkspacePath: string
}): string {
  return resolvedFloatingWorkspacePath
}

export function FloatingWorkspacePane({
  settings,
  updateSettings
}: FloatingWorkspacePaneProps): React.JSX.Element | null {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const [resolvedFloatingWorkspacePath, setResolvedFloatingWorkspacePath] = useState('')

  useEffect(() => {
    let cancelled = false
    void window.api.app
      .getFloatingTerminalCwd({
        path: settings.floatingTerminalCwd,
        requireTrusted: true
      })
      .then((path) => {
        if (!cancelled) {
          setResolvedFloatingWorkspacePath(path)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolvedFloatingWorkspacePath('')
        }
      })
    return () => {
      cancelled = true
    }
  }, [settings.floatingTerminalCwd])

  const pickFloatingWorkspaceDirectory = async (): Promise<void> => {
    const path = await window.api.app.pickFloatingWorkspaceDirectory()
    if (!path) {
      return
    }
    updateSettings({ floatingTerminalCwd: path })
  }

  const directoryInputValue = getFloatingWorkspaceDirectoryInputValue({
    resolvedFloatingWorkspacePath
  })

  if (!matchesSettingsSearch(searchQuery, FLOATING_WORKSPACE_SEARCH_ENTRIES)) {
    return null
  }

  return (
    <section className="space-y-4">
      <SearchableSetting
        title="Floating Workspace"
        description="Enable the floating workspace and choose where new tabs start."
        keywords={[
          'floating workspace',
          'floating terminal',
          'terminal',
          'browser',
          'markdown',
          'note',
          'global',
          'quick panel',
          'launch directory'
        ]}
        className="space-y-3"
      >
        <div className="flex items-center justify-between gap-4 px-1 py-2">
          <div className="space-y-0.5">
            <Label>Enable Floating Workspace</Label>
            <p className="text-xs text-muted-foreground">
              Shows the floating workspace button and panel.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-label="Enable Floating Workspace"
            aria-checked={settings.floatingTerminalEnabled}
            onClick={() =>
              updateSettings({
                floatingTerminalEnabled: !settings.floatingTerminalEnabled
              })
            }
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
              settings.floatingTerminalEnabled ? 'bg-foreground' : 'bg-muted-foreground/30'
            }`}
          >
            <span
              className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                settings.floatingTerminalEnabled ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        <div className="space-y-2">
          <Label>Default Directory</Label>
          <div className="flex max-w-xl gap-2">
            <Input
              value={directoryInputValue}
              readOnly
              placeholder="Orca floating workspace"
              className="min-w-0 flex-1"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Choose floating workspace directory"
              onClick={() => void pickFloatingWorkspaceDirectory()}
            >
              <FolderOpen className="size-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            New floating workspace tabs start here. The default is the Orca app-owned workspace.
          </p>
        </div>

        <div className="space-y-2">
          <Label>Toggle Button Location</Label>
          <ToggleGroup
            type="single"
            value={settings.floatingTerminalTriggerLocation ?? 'floating-button'}
            onValueChange={(value) => {
              if (!value) {
                return
              }
              updateSettings({
                floatingTerminalTriggerLocation: value as FloatingTerminalTriggerLocation
              })
            }}
            className="justify-start"
          >
            <ToggleGroupItem value="floating-button">Floating Button</ToggleGroupItem>
            <ToggleGroupItem value="status-bar">Status Bar</ToggleGroupItem>
          </ToggleGroup>
          <p className="text-xs text-muted-foreground">
            The keyboard shortcut works regardless of where the toggle is shown.
          </p>
        </div>
      </SearchableSetting>
    </section>
  )
}
