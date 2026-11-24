import { useId, useState } from 'react'
import { Info } from 'lucide-react'
import { Button } from '../../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { Switch } from '../../ui/switch'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { SettingsRow, SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroupNestedRows } from '../section-layout/SettingsGroup'
import {
  getAutomaticUpdatesAwaySettingCopy,
  getAutomaticUpdatesSettingCopy
} from './automatic-updates-copy'

export function AutomaticUpdatesSetting(): React.JSX.Element {
  const t = useTranslate()
  const enabled = useAppStore((state) => state.settings?.automaticUpdates === true)
  const waitUntilAway = useAppStore(
    (state) => state.settings?.automaticUpdatesWaitUntilAway === true
  )
  const settingsLoaded = useAppStore((state) => state.settings !== null)
  const updateSettings = useAppStore((state) => state.updateSettingsOrThrow)
  const switchId = useId()
  const [saving, setSaving] = useState(false)
  const { title, description } = getAutomaticUpdatesSettingCopy(t)
  const away = getAutomaticUpdatesAwaySettingCopy(t)

  function save(updates: Partial<GlobalSettings>): void {
    setSaving(true)
    void updateSettings(updates)
      .catch(() => {
        toast.error(t('settings.automaticUpdates.saveFailed', 'Could not save automatic updates.'))
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
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t('settings.automaticUpdates.info', 'About automatic updates')}
              >
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
            onCheckedChange={() => save({ automaticUpdates: !enabled })}
            disabled={!settingsLoaded || saving}
          />
        }
      />
      {enabled ? (
        <SettingsGroupNestedRows>
          <SettingsSwitchRow
            label={away.title}
            description={away.description}
            checked={waitUntilAway}
            disabled={!settingsLoaded || saving}
            onChange={() => save({ automaticUpdatesWaitUntilAway: !waitUntilAway })}
          />
        </SettingsGroupNestedRows>
      ) : null}
    </SearchableSetting>
  )
}
