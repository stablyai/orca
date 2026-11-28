import { useId, useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { Switch } from '../../ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { getAutomaticUpdatesSettingCopy } from './automatic-updates-copy'

export function AutomaticUpdatesSetting(): React.JSX.Element {
  const t = useTranslate()
  const enabled = useAppStore((state) => state.settings?.automaticUpdates === true)
  const settingsLoaded = useAppStore((state) => state.settings !== null)
  const updateSettings = useAppStore((state) => state.updateSettingsOrThrow)
  const switchId = useId()
  const descriptionId = useId()
  const [saving, setSaving] = useState(false)
  const { title, description } = getAutomaticUpdatesSettingCopy(t)

  function toggleAutomaticUpdates(): void {
    setSaving(true)
    void updateSettings({ automaticUpdates: !enabled })
      .catch(() => {
        toast.error(t('settings.automaticUpdates.saveFailed', 'Could not save automatic updates.'))
      })
      .finally(() => setSaving(false))
  }

  return (
    <SearchableSetting title={title} description={description}>
      {/* The restart explanation is a tooltip on both the label (hover) and the switch (hover and
          keyboard focus), so the row stays one line. */}
      <SettingsRow
        label={
          <Tooltip>
            <TooltipTrigger asChild>
              <span>{title}</span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4} className="max-w-xs">
              {description}
            </TooltipContent>
          </Tooltip>
        }
        htmlFor={switchId}
        control={
          <Tooltip>
            {/* A wrapper is the trigger: the tooltip's data-state would replace the switch's own. */}
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Switch
                  id={switchId}
                  aria-describedby={descriptionId}
                  checked={enabled}
                  onCheckedChange={toggleAutomaticUpdates}
                  disabled={!settingsLoaded || saving}
                />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4} className="max-w-xs">
              {description}
            </TooltipContent>
          </Tooltip>
        }
      />
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
    </SearchableSetting>
  )
}
