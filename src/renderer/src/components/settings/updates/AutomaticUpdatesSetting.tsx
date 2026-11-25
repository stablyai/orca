import { useId, useState } from 'react'
import { Info } from 'lucide-react'
import { Button } from '../../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { Switch } from '../../ui/switch'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import {
  getAutomaticUpdateChecksSettingCopy,
  getAutomaticUpdatesSettingCopy
} from './automatic-updates-copy'

type UpdateToggleSettingProps = {
  settingKey: 'automaticUpdates' | 'automaticUpdateChecks'
  title: string
  description: string
  infoLabel: string
  saveFailedMessage: string
}

function UpdateToggleSetting({
  settingKey,
  title,
  description,
  infoLabel,
  saveFailedMessage
}: UpdateToggleSettingProps): React.JSX.Element {
  const enabled = useAppStore((state) => state.settings?.[settingKey] === true)
  const settingsLoaded = useAppStore((state) => state.settings !== null)
  const updateSettings = useAppStore((state) => state.updateSettingsOrThrow)
  const switchId = useId()
  const [saving, setSaving] = useState(false)

  function toggle(): void {
    setSaving(true)
    void updateSettings({ [settingKey]: !enabled })
      .catch(() => {
        toast.error(saveFailedMessage)
      })
      .finally(() => setSaving(false))
  }

  return (
    <SearchableSetting title={title} description={description}>
      <SettingsRow
        label={title}
        htmlFor={switchId}
        labelAccessory={
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="ghost" size="icon-xs" aria-label={infoLabel}>
                <Info className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4} className="max-w-xs">
              {description}
            </TooltipContent>
          </Tooltip>
        }
        control={
          <Switch
            id={switchId}
            checked={enabled}
            onCheckedChange={toggle}
            disabled={!settingsLoaded || saving}
          />
        }
      />
    </SearchableSetting>
  )
}

export function AutomaticUpdatesSetting(): React.JSX.Element {
  const t = useTranslate()
  return (
    <UpdateToggleSetting
      settingKey="automaticUpdates"
      {...getAutomaticUpdatesSettingCopy(t)}
      infoLabel={t('settings.automaticUpdates.info', 'About automatic updates')}
      saveFailedMessage={t(
        'settings.automaticUpdates.saveFailed',
        'Could not save automatic updates.'
      )}
    />
  )
}

export function AutomaticUpdateChecksSetting(): React.JSX.Element {
  const t = useTranslate()
  return (
    <UpdateToggleSetting
      settingKey="automaticUpdateChecks"
      {...getAutomaticUpdateChecksSettingCopy(t)}
      infoLabel={t('settings.automaticUpdateChecks.info', 'About automatic update checks')}
      saveFailedMessage={t(
        'settings.automaticUpdateChecks.saveFailed',
        'Could not save automatic update checks.'
      )}
    />
  )
}
