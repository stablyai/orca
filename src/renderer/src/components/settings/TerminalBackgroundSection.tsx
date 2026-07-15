import type { GlobalSettings } from '../../../../shared/types'
import { NumberField, SettingsSubsectionHeader } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { TerminalBackgroundImageSetting } from './TerminalBackgroundImageSetting'
import { clampNumber } from '@/lib/terminal-theme'
import { translate } from '@/i18n/i18n'

type TerminalBackgroundSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

// Why: background opacity and the background image are a pair — the image is
// only visible when opacity is below 1 — so they live together in a primary,
// always-visible section instead of being buried under the advanced disclosure.
export function TerminalBackgroundSection({
  settings,
  updateSettings
}: TerminalBackgroundSectionProps): React.JSX.Element {
  return (
    <section className="space-y-3 pt-2">
      <SettingsSubsectionHeader
        title={translate(
          'auto.components.settings.TerminalBackgroundSection.7c1f4a9e02',
          'Background'
        )}
        description={translate(
          'auto.components.settings.TerminalBackgroundSection.2d5b8c3f14',
          'Terminal background transparency and image.'
        )}
      />

      <div className="ml-4 grid gap-4">
        <SearchableSetting
          title={translate(
            'auto.components.settings.TerminalWindowSection.ea7b1a158e',
            'Background Opacity'
          )}
          description={translate(
            'auto.components.settings.TerminalWindowSection.03acb60aa0',
            'Controls the transparency of the terminal background.'
          )}
          keywords={['opacity', 'transparency', 'background', 'alpha']}
        >
          <NumberField
            label={translate(
              'auto.components.settings.TerminalWindowSection.ea7b1a158e',
              'Background Opacity'
            )}
            description={translate(
              'auto.components.settings.TerminalWindowSection.809f37738d',
              'Controls the transparency of the terminal background. 1 is fully opaque, 0 is fully transparent.'
            )}
            value={settings.terminalBackgroundOpacity ?? 1}
            defaultValue={1}
            min={0}
            max={1}
            step={0.05}
            suffix="0 to 1"
            onChange={(value) =>
              updateSettings({ terminalBackgroundOpacity: clampNumber(value, 0, 1) })
            }
          />
        </SearchableSetting>

        <TerminalBackgroundImageSetting settings={settings} updateSettings={updateSettings} />
      </div>
    </section>
  )
}
