import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { Label } from '../../ui/label'
import { Switch } from '../../ui/switch'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { isDefaultPrimarySelectionMiddleClickPasteUserAgent } from '@/hooks/usePrimarySelectionPaste'
import { useTranslate } from '@/i18n/use-translate'

type InputPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function InputPane({ settings, updateSettings }: InputPaneProps): React.JSX.Element {
  const t = useTranslate()
  const enabled =
    settings.primarySelectionMiddleClickPaste ??
    isDefaultPrimarySelectionMiddleClickPasteUserAgent()

  return (
    <section className="space-y-4">
      <SearchableSetting
        title={t(
          'auto.components.settings.InputPane.dc26974909',
          'Middle-click paste from selection'
        )}
        description={t(
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
            {t(
              'auto.components.settings.InputPane.dc26974909',
              'Middle-click paste from selection'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.settings.InputPane.db15068196',
              'Enabled by default on Linux and macOS. Linux uses the system selection clipboard; other platforms use a private buffer.'
            )}
          </p>
        </div>
        <Switch
          aria-label={t(
            'auto.components.settings.InputPane.dc26974909',
            'Middle-click paste from selection'
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
