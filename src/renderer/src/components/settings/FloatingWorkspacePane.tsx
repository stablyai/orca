import { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import type { FloatingTerminalTriggerLocation, GlobalSettings } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSwitchRow } from './SettingsFormControls'
import { FLOATING_WORKSPACE_SEARCH_ENTRIES } from './floating-workspace-search'
import { matchesSettingsSearch } from './settings-search'
import { useAppStore } from '../../store'

type FloatingWorkspacePaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function getFloatingWorkspaceDirectoryInputValue({
  configuredFloatingWorkspacePath,
  resolvedFloatingWorkspacePath
}: {
  configuredFloatingWorkspacePath: string
  resolvedFloatingWorkspacePath: string
}): string {
  const configuredPath = configuredFloatingWorkspacePath.trim()
  if (!configuredPath || configuredPath === '~') {
    return '~'
  }
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
        path: settings.floatingTerminalCwd
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
    configuredFloatingWorkspacePath: settings.floatingTerminalCwd,
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
        className="divide-y divide-border/40"
      >
        <SettingsSwitchRow
          label="Enable Floating Workspace"
          description="Shows the floating workspace button and panel."
          checked={settings.floatingTerminalEnabled}
          onChange={() =>
            updateSettings({
              floatingTerminalEnabled: !settings.floatingTerminalEnabled
            })
          }
        />

        <SettingsRow
          alignTop
          label="Terminal Directory"
          description="New floating terminal tabs start here. Markdown notes are saved in Orca's app-owned floating workspace."
          control={
            <div className="flex w-72 max-w-full gap-2">
              <Input
                value={directoryInputValue}
                readOnly
                placeholder="~"
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
          }
        />

        <SettingsRow
          label="Toggle Button Location"
          description="The keyboard shortcut works regardless of where the toggle is shown."
          control={
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
            >
              <ToggleGroupItem value="floating-button">Floating Button</ToggleGroupItem>
              <ToggleGroupItem value="status-bar">Status Bar</ToggleGroupItem>
            </ToggleGroup>
          }
        />
      </SearchableSetting>
    </section>
  )
}
