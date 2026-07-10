import type { GlobalSettings } from '../../../../shared/types'
import { Label } from '../ui/label'
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
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() =>
            updateSettings({
              primarySelectionMiddleClickPaste: !enabled
            })
          }
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
            enabled ? 'bg-foreground' : 'bg-muted-foreground/30'
          }`}
        >
          <span
            className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
              enabled ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </SearchableSetting>
    </section>
  )
}
