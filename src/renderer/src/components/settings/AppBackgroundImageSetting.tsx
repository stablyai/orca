import type React from 'react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  DEFAULT_APP_BACKGROUND_IMAGE_FIT,
  DEFAULT_APP_BACKGROUND_IMAGE_OPACITY,
  MAX_APP_BACKGROUND_IMAGE_OPACITY,
  type AppBackgroundImageFit
} from '../../../../shared/app-background-image'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { NumberField, SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'

type AppBackgroundImageSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function AppBackgroundImageSetting({
  settings,
  updateSettings
}: AppBackgroundImageSettingProps): React.JSX.Element {
  const hasImage = Boolean(settings.appBackgroundImage)

  const handlePickImage = async (): Promise<void> => {
    try {
      const result = await window.api.shell.pickAppBackgroundImage()
      if (!result) {
        return
      }
      updateSettings({ appBackgroundImage: result.dataUrl })
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.settings.AppBackgroundImageSetting.pickFailed',
              'Could not load that image.'
            )
      )
    }
  }

  return (
    <div className="space-y-2">
      <SettingsRow
        alignTop
        label={translate(
          'auto.components.settings.AppBackgroundImageSetting.title',
          'Window Background Image'
        )}
        description={translate(
          'auto.components.settings.AppBackgroundImageSetting.rowDescription',
          'Draw an image as a subtle texture across the whole window.'
        )}
        control={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handlePickImage}>
              {hasImage
                ? translate(
                    'auto.components.settings.AppBackgroundImageSetting.replaceImage',
                    'Replace Image…'
                  )
                : translate(
                    'auto.components.settings.AppBackgroundImageSetting.chooseImage',
                    'Choose Image…'
                  )}
            </Button>
            {hasImage ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => updateSettings({ appBackgroundImage: undefined })}
              >
                {translate('auto.components.settings.AppBackgroundImageSetting.remove', 'Remove')}
              </Button>
            ) : null}
          </div>
        }
      />
      {hasImage ? (
        <div className="space-y-2">
          <NumberField
            label={translate(
              'auto.components.settings.AppBackgroundImageSetting.opacity',
              'Texture Strength'
            )}
            description={translate(
              'auto.components.settings.AppBackgroundImageSetting.opacityDescription',
              'Controls how visible the image is over the window.'
            )}
            value={settings.appBackgroundImageOpacity ?? DEFAULT_APP_BACKGROUND_IMAGE_OPACITY}
            defaultValue={DEFAULT_APP_BACKGROUND_IMAGE_OPACITY}
            min={0}
            max={MAX_APP_BACKGROUND_IMAGE_OPACITY}
            step={0.01}
            suffix={`0 to ${MAX_APP_BACKGROUND_IMAGE_OPACITY}`}
            onChange={(appBackgroundImageOpacity) => updateSettings({ appBackgroundImageOpacity })}
          />
          <SettingsRow
            label={translate('auto.components.settings.AppBackgroundImageSetting.fit', 'Image Fit')}
            description={translate(
              'auto.components.settings.AppBackgroundImageSetting.fitDescription',
              'How the image is scaled to the window.'
            )}
            control={
              <SettingsSegmentedControl<AppBackgroundImageFit>
                size="sm"
                value={settings.appBackgroundImageFit ?? DEFAULT_APP_BACKGROUND_IMAGE_FIT}
                onChange={(appBackgroundImageFit) => updateSettings({ appBackgroundImageFit })}
                ariaLabel={translate(
                  'auto.components.settings.AppBackgroundImageSetting.fit',
                  'Image Fit'
                )}
                options={[
                  {
                    value: 'cover',
                    label: translate(
                      'auto.components.settings.AppBackgroundImageSetting.fitCover',
                      'Cover'
                    )
                  },
                  {
                    value: 'contain',
                    label: translate(
                      'auto.components.settings.AppBackgroundImageSetting.fitContain',
                      'Contain'
                    )
                  },
                  {
                    value: 'stretch',
                    label: translate(
                      'auto.components.settings.AppBackgroundImageSetting.fitStretch',
                      'Stretch'
                    )
                  },
                  {
                    value: 'center',
                    label: translate(
                      'auto.components.settings.AppBackgroundImageSetting.fitCenter',
                      'Center'
                    )
                  }
                ]}
              />
            }
          />
        </div>
      ) : null}
    </div>
  )
}
