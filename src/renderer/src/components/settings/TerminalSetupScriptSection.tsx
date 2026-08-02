import type { GlobalSettings, SetupScriptLaunchMode } from '../../../../shared/types'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { SettingsRow, SettingsSubsectionHeader } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { translate } from '@/i18n/i18n'

type TerminalSetupScriptSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TerminalSetupScriptSection({
  settings,
  updateSettings
}: TerminalSetupScriptSectionProps): React.JSX.Element {
  return (
    <section key="setup-script" className="space-y-3">
      <SettingsSubsectionHeader
        title={translate(
          'auto.components.settings.TerminalPane.21f8da2078',
          'Workspace Setup Script'
        )}
        description={translate(
          'auto.components.settings.TerminalPane.34a0dfa06e',
          'Where the repository setup script runs when a new workspace is created.'
        )}
      />

      <div className="divide-y divide-border/40">
        <SearchableSetting
          title={translate(
            'auto.components.settings.TerminalPane.d23b43c5be',
            'Setup Script Location'
          )}
          description={translate(
            'auto.components.settings.TerminalPane.34a0dfa06e',
            'Where the repository setup script runs when a new workspace is created.'
          )}
          keywords={[
            'setup',
            'script',
            'workspace',
            'split',
            'horizontal',
            'vertical',
            'tab',
            'new',
            'location',
            'launch'
          ]}
        >
          <SettingsRow
            label={translate(
              'auto.components.settings.TerminalPane.d23b43c5be',
              'Setup Script Location'
            )}
            description={translate(
              'auto.components.settings.TerminalPane.a9d47451d1',
              '"New Tab" opens the setup command in a background tab titled "Setup" without stealing focus.'
            )}
            control={
              <ToggleGroup
                type="single"
                value={settings.setupScriptLaunchMode}
                onValueChange={(value) => {
                  if (!value) {
                    return
                  }
                  updateSettings({
                    setupScriptLaunchMode: value as SetupScriptLaunchMode
                  })
                }}
                variant="outline"
                size="sm"
                className="h-8 flex-wrap"
              >
                <ToggleGroupItem
                  value="new-tab"
                  className="h-8 px-3 text-xs"
                  aria-label={translate(
                    'auto.components.settings.TerminalPane.6c6a054a1c',
                    'Run in a new tab'
                  )}
                >
                  {translate('auto.components.settings.TerminalPane.1158f8fd55', 'New Tab')}
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="split-vertical"
                  className="h-8 px-3 text-xs"
                  aria-label={translate(
                    'auto.components.settings.TerminalPane.691ce810e0',
                    'Split vertically'
                  )}
                >
                  {translate(
                    'auto.components.settings.TerminalPane.332e8a2872',
                    'Split Vertically'
                  )}
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="split-horizontal"
                  className="h-8 px-3 text-xs"
                  aria-label={translate(
                    'auto.components.settings.TerminalPane.623e62df99',
                    'Split horizontally'
                  )}
                >
                  {translate(
                    'auto.components.settings.TerminalPane.003df129fe',
                    'Split Horizontally'
                  )}
                </ToggleGroupItem>
              </ToggleGroup>
            }
          />
        </SearchableSetting>
      </div>
    </section>
  )
}
