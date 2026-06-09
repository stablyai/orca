import { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import type { FloatingTerminalTriggerLocation, GlobalSettings } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSwitchRow } from './SettingsFormControls'
import { getFloatingWorkspaceSearchEntries } from './floating-workspace-search'
import { matchesSettingsSearch } from './settings-search'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'

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
    useAppStore.getState().recordFeatureInteraction('floating-workspace')
    updateSettings({ floatingTerminalCwd: path })
  }

  const directoryInputValue = getFloatingWorkspaceDirectoryInputValue({
    configuredFloatingWorkspacePath: settings.floatingTerminalCwd,
    resolvedFloatingWorkspacePath
  })

  if (!matchesSettingsSearch(searchQuery, getFloatingWorkspaceSearchEntries())) {
    return null
  }

  return (
    <section className="space-y-4">
      <SearchableSetting
        title={translate(
          'auto.components.settings.FloatingWorkspacePane.1f67f39384',
          'Floating Workspace'
        )}
        description={translate(
          'auto.components.settings.FloatingWorkspacePane.37df688d6f',
          'Enable the floating workspace and choose where new tabs start.'
        )}
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
          label={translate(
            'auto.components.settings.FloatingWorkspacePane.5136813663',
            'Enable Floating Workspace'
          )}
          description={translate(
            'auto.components.settings.FloatingWorkspacePane.41eb95f7f0',
            'Shows the floating workspace button and panel.'
          )}
          checked={settings.floatingTerminalEnabled}
          onChange={() => {
            if (!settings.floatingTerminalEnabled) {
              useAppStore.getState().recordFeatureInteraction('floating-workspace')
            }
            updateSettings({
              floatingTerminalEnabled: !settings.floatingTerminalEnabled
            })
          }}
        />

        <SettingsRow
          alignTop
          label={translate(
            'auto.components.settings.FloatingWorkspacePane.12aa09f10c',
            'Terminal Directory'
          )}
          description={translate(
            'auto.components.settings.FloatingWorkspacePane.81afb79785',
            "New floating terminal tabs start here. Markdown notes are saved in Orca's app-owned floating workspace."
          )}
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
                aria-label={translate(
                  'auto.components.settings.FloatingWorkspacePane.505001823e',
                  'Choose floating workspace directory'
                )}
                onClick={() => void pickFloatingWorkspaceDirectory()}
              >
                <FolderOpen className="size-4" />
              </Button>
            </div>
          }
        />

        <SettingsRow
          label={translate(
            'auto.components.settings.FloatingWorkspacePane.5e5a8da236',
            'Toggle Button Location'
          )}
          description={translate(
            'auto.components.settings.FloatingWorkspacePane.3c900e26e5',
            'The keyboard shortcut works regardless of where the toggle is shown.'
          )}
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
                useAppStore.getState().recordFeatureInteraction('floating-workspace')
              }}
            >
              <ToggleGroupItem value="floating-button">
                {translate(
                  'auto.components.settings.FloatingWorkspacePane.9fb225f2d7',
                  'Floating Button'
                )}
              </ToggleGroupItem>
              <ToggleGroupItem value="status-bar">
                {translate(
                  'auto.components.settings.FloatingWorkspacePane.aeaf76fda9',
                  'Status Bar'
                )}
              </ToggleGroupItem>
            </ToggleGroup>
          }
        />
      </SearchableSetting>
    </section>
  )
}
