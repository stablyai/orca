import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { SearchableSetting } from './SearchableSetting'
import { isDefaultPrimarySelectionMiddleClickPasteUserAgent } from '@/hooks/usePrimarySelectionPaste'
import { translate } from '@/i18n/i18n'
export { getInputPaneSearchEntries } from './input-search'

type InputPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function InputPane({ settings, updateSettings }: InputPaneProps): React.JSX.Element {
  const enabled =
    settings.primarySelectionMiddleClickPaste ??
    isDefaultPrimarySelectionMiddleClickPasteUserAgent()

  return (
    <section className="space-y-4">
      <SearchableSetting
        title={translate(
          'auto.components.settings.InputPane.ad31c3c5fb',
          'Middle-click Paste from Selection'
        )}
        description={translate(
          'auto.components.settings.InputPane.db15068196',
          'Enabled by default on Linux and macOS. Linux uses the system selection clipboard; other platforms use a private buffer.'
        )}
        keywords={[
          'input',
          'editing',
          'selection',
          'primary selection',
          'middle click',
          'middle mouse',
          'paste',
          'clipboard',
          'x11',
          'linux',
          'macos'
        ]}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.InputPane.ad31c3c5fb',
              'Middle-click Paste from Selection'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.InputPane.db15068196',
              'Enabled by default on Linux and macOS. Linux uses the system selection clipboard; other platforms use a private buffer.'
            )}
          </p>
        </div>
        <Switch
          aria-label={translate(
            'auto.components.settings.InputPane.ad31c3c5fb',
            'Middle-click Paste from Selection'
          )}
          checked={enabled}
          onCheckedChange={(checked) =>
            updateSettings({
              primarySelectionMiddleClickPaste: checked
            })
          }
        />
      </SearchableSetting>
    </section>
  )
}
