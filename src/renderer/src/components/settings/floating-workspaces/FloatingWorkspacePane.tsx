import { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { floatingWorkspaceUnavailableReason } from '@/components/floating-terminal/floating-workspace-availability'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { FloatingTerminalTriggerLocation } from '../../../../../shared/ui-chrome-types'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsRow, SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { getFloatingWorkspaceSearchEntries } from './floating-workspace-search'
import { matchesSettingsSearch } from '../search/settings-search'
import { useAppStore } from '../../../store/index'
import { useTranslate } from '@/i18n/use-translate'
import { isWebClientLocation } from '@/lib/web-client-location'

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
  const t = useTranslate()
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const includeBrowser = !isWebClientLocation()
  // Pass the component's translator so a language change re-renders the reason.
  const unavailableReason = floatingWorkspaceUnavailableReason(t)
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

  if (!matchesSettingsSearch(searchQuery, getFloatingWorkspaceSearchEntries({ includeBrowser }))) {
    return null
  }

  return (
    <section className="space-y-4">
      <SearchableSetting
        title={t('auto.components.settings.FloatingWorkspacePane.2374e81dd8', 'Floating workspace')}
        description={t(
          'auto.components.settings.FloatingWorkspacePane.37df688d6f',
          'Enable the floating workspace and choose where new tabs start.'
        )}
        keywords={[
          'floating workspace',
          'floating terminal',
          'terminal',
          ...(includeBrowser ? ['browser'] : []),
          'markdown',
          'note',
          'global',
          'quick panel',
          'launch directory'
        ]}
        className="divide-y divide-border/40"
      >
        <SettingsSwitchRow
          label={t(
            'auto.components.settings.FloatingWorkspacePane.172d1d75c3',
            'Enable floating workspace'
          )}
          description={
            unavailableReason ??
            t(
              'auto.components.settings.FloatingWorkspacePane.41eb95f7f0',
              'Shows the floating workspace button and panel.'
            )
          }
          disabled={unavailableReason !== null}
          checked={settings.floatingTerminalEnabled}
          onChange={() => {
            if (!settings.floatingTerminalEnabled) {
              useAppStore.getState().recordFeatureInteraction('floating-workspace')
            } else {
              useAppStore.getState().recordFeatureInteraction('floating-workspace-hidden')
            }
            updateSettings({
              floatingTerminalEnabled: !settings.floatingTerminalEnabled
            })
          }}
        />

        <SettingsRow
          alignTop
          label={t(
            'auto.components.settings.FloatingWorkspacePane.7cedc178d6',
            'Terminal directory'
          )}
          description={t(
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
                aria-label={t(
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
          label={t(
            'auto.components.settings.FloatingWorkspacePane.b9c2a85346',
            'Toggle button location'
          )}
          description={t(
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
                {t('auto.components.settings.FloatingWorkspacePane.73ac917638', 'Floating button')}
              </ToggleGroupItem>
              <ToggleGroupItem value="status-bar">
                {t('auto.components.settings.FloatingWorkspacePane.dd7eb9270a', 'Status bar')}
              </ToggleGroupItem>
            </ToggleGroup>
          }
        />
      </SearchableSetting>
    </section>
  )
}
