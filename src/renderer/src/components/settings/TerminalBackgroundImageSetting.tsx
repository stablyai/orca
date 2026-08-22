import { useState } from 'react'
import { ImagePlus, X } from 'lucide-react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  DEFAULT_TERMINAL_BACKGROUND_IMAGE_FIT,
  DEFAULT_TERMINAL_BACKGROUND_IMAGE_OPACITY,
  type TerminalBackgroundImageFit
} from '../../../../shared/terminal-background-image'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { NumberField, SettingsSegmentedControl } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { clampNumber } from '@/lib/terminal-theme'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'

type TerminalBackgroundImageSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TerminalBackgroundImageSetting({
  settings,
  updateSettings
}: TerminalBackgroundImageSettingProps): React.JSX.Element {
  const [picking, setPicking] = useState(false)
  const mountedRef = useMountedRef()
  const image = settings.terminalBackgroundImage

  const handlePickImage = async (): Promise<void> => {
    if (picking) {
      return
    }
    setPicking(true)
    try {
      const result = await window.api.shell.pickTerminalBackgroundImage()
      if (!result || !mountedRef.current) {
        return
      }
      updateSettings({ terminalBackgroundImage: result.dataUrl })
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.settings.TerminalBackgroundImageSetting.38b326d424',
              'Failed to load background image'
            )
      )
    } finally {
      if (mountedRef.current) {
        setPicking(false)
      }
    }
  }

  const fitOptions: { value: TerminalBackgroundImageFit; label: string }[] = [
    {
      value: 'cover',
      label: translate(
        'auto.components.settings.TerminalBackgroundImageSetting.0bdb168ee2',
        'Cover'
      )
    },
    {
      value: 'contain',
      label: translate(
        'auto.components.settings.TerminalBackgroundImageSetting.67dd10e508',
        'Contain'
      )
    },
    {
      value: 'stretch',
      label: translate(
        'auto.components.settings.TerminalBackgroundImageSetting.3f2880d508',
        'Stretch'
      )
    },
    {
      value: 'center',
      label: translate(
        'auto.components.settings.TerminalBackgroundImageSetting.64e97c6791',
        'Center'
      )
    }
  ]

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.TerminalBackgroundImageSetting.ae369d4605',
        'Background Image'
      )}
      description={translate(
        'auto.components.settings.TerminalBackgroundImageSetting.b6559dbb21',
        'Draw an image behind every terminal pane.'
      )}
      keywords={['image', 'wallpaper', 'picture', 'background']}
      className="space-y-3 py-2"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.TerminalBackgroundImageSetting.ae369d4605',
              'Background Image'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.TerminalBackgroundImageSetting.b6559dbb21',
              'Draw an image behind every terminal pane.'
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {image ? (
            <img
              src={image}
              alt={translate(
                'auto.components.settings.TerminalBackgroundImageSetting.d434de1d39',
                'Terminal background preview'
              )}
              className="size-9 rounded-md border border-border object-cover"
            />
          ) : null}
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={picking}
            onClick={() => void handlePickImage()}
          >
            <ImagePlus className="size-3.5" />
            {translate(
              'auto.components.settings.TerminalBackgroundImageSetting.5b2d06d2ae',
              'Choose image…'
            )}
          </Button>
          {image ? (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={() => updateSettings({ terminalBackgroundImage: undefined })}
            >
              <X className="size-3.5" />
              {translate(
                'auto.components.settings.TerminalBackgroundImageSetting.9adb6af93d',
                'Remove'
              )}
            </Button>
          ) : null}
        </div>
      </div>

      {image ? (
        <div className="space-y-3">
          <NumberField
            label={translate(
              'auto.components.settings.TerminalBackgroundImageSetting.ec2d7b014e',
              'Image Opacity'
            )}
            description={translate(
              'auto.components.settings.TerminalBackgroundImageSetting.adfba5db13',
              'How strongly the image shows through. 0 hides it, 1 is fully visible.'
            )}
            value={
              settings.terminalBackgroundImageOpacity ?? DEFAULT_TERMINAL_BACKGROUND_IMAGE_OPACITY
            }
            defaultValue={DEFAULT_TERMINAL_BACKGROUND_IMAGE_OPACITY}
            min={0}
            max={1}
            step={0.05}
            suffix="0 to 1"
            onChange={(value) =>
              updateSettings({ terminalBackgroundImageOpacity: clampNumber(value, 0, 1) })
            }
          />
          <div className="flex items-center justify-between gap-4">
            <Label>
              {translate(
                'auto.components.settings.TerminalBackgroundImageSetting.2ff86e95a3',
                'Image Fit'
              )}
            </Label>
            <SettingsSegmentedControl
              size="sm"
              ariaLabel={translate(
                'auto.components.settings.TerminalBackgroundImageSetting.2ff86e95a3',
                'Image Fit'
              )}
              value={settings.terminalBackgroundImageFit ?? DEFAULT_TERMINAL_BACKGROUND_IMAGE_FIT}
              options={fitOptions}
              onChange={(value) => updateSettings({ terminalBackgroundImageFit: value })}
            />
          </div>
        </div>
      ) : null}
    </SearchableSetting>
  )
}
