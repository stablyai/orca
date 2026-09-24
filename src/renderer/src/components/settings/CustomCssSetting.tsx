import { useEffect, useState } from 'react'
import type React from 'react'
import { ExternalLink, FolderOpen } from 'lucide-react'
import { CUSTOM_CSS_MAX_BYTES, type CustomCssFileError } from '../../../../shared/custom-css'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { isWebClientLocation } from '@/lib/web-client-location'
import { Button } from '../ui/button'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import { getCustomCssEntries } from './appearance-search'

type CustomCssSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

function describeFileError(error: CustomCssFileError): string {
  if (error.kind === 'too-large') {
    return translate(
      'settings.appearance.customCss.tooLarge',
      'custom.css is larger than {{limit}} KB and was not loaded.',
      { limit: CUSTOM_CSS_MAX_BYTES / 1024 }
    )
  }
  return translate(
    'settings.appearance.customCss.unreadable',
    'custom.css could not be read: {{message}}',
    {
      message: error.message
    }
  )
}

function useCustomCssFileError(enabled: boolean): CustomCssFileError | null {
  const [error, setError] = useState<CustomCssFileError | null>(null)
  useEffect(() => {
    if (!enabled || isWebClientLocation()) {
      setError(null)
      return
    }
    let disposed = false
    const update = (snapshot: { error: CustomCssFileError | null } | undefined): void => {
      if (!disposed && snapshot) {
        setError(snapshot.error)
      }
    }
    const offChanged = window.api.customCss.onChanged(update)
    void Promise.resolve(window.api.customCss.get())
      .then(update)
      .catch(() => undefined)
    return () => {
      disposed = true
      offChanged()
    }
  }, [enabled])
  return error
}

function runFileAction(action: () => Promise<unknown>, label: string): void {
  void action().catch((error: unknown) => console.error(`Failed to ${label} custom.css:`, error))
}

export function CustomCssSetting({
  settings,
  updateSettings
}: CustomCssSettingProps): React.JSX.Element | null {
  const [entry] = getCustomCssEntries()
  const enabled = settings.customCssEnabled === true
  const fileError = useCustomCssFileError(enabled)
  if (isWebClientLocation()) {
    return null
  }
  const title = translate('settings.appearance.customCss.title', 'Custom CSS')

  return (
    <SearchableSetting
      title={title}
      description={entry?.description}
      keywords={entry?.keywords ?? ['css', 'theme', 'colors', 'style']}
    >
      <SettingsSwitchRow
        label={title}
        // Why: the file location and live reload aren't discoverable from the toggle.
        description={translate(
          'settings.appearance.customCss.description',
          'Load ~/.orca/custom.css on top of the built-in theme. Changes apply as soon as you save the file.'
        )}
        checked={enabled}
        onChange={() => updateSettings({ customCssEnabled: !enabled })}
      />
      {enabled ? (
        <div className="flex gap-2 pb-3">
          <Button
            variant="outline"
            size="xs"
            onClick={() => runFileAction(() => window.api.customCss.openFile(), 'open')}
          >
            <ExternalLink className="size-3.5" />
            {translate('settings.appearance.customCss.openFile', 'Open custom.css')}
          </Button>
          <Button
            variant="outline"
            size="xs"
            onClick={() => runFileAction(() => window.api.customCss.revealFile(), 'reveal')}
          >
            <FolderOpen className="size-3.5" />
            {translate('settings.appearance.customCss.revealFile', 'Reveal in File Manager')}
          </Button>
        </div>
      ) : null}
      {enabled && fileError ? (
        <p className="pb-3 text-xs text-destructive">{describeFileError(fileError)}</p>
      ) : null}
    </SearchableSetting>
  )
}
