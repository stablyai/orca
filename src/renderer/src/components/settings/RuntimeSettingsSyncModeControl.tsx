import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { SettingsSwitch } from './SettingsFormControls'

export function RuntimeSettingsSyncModeControl({
  checked,
  disabled,
  onChange
}: {
  checked: boolean
  disabled: boolean
  onChange: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-muted/20 p-3">
      <div className="space-y-1">
        <Label id="portable-settings-continuous-sync-label" className="text-sm font-medium">
          {translate(
            'auto.components.settings.RuntimeSettingsSyncDialog.keepInSync',
            'Keep these settings in sync'
          )}
        </Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RuntimeSettingsSyncDialog.keepInSyncHelp',
            'This Orca becomes the source of truth. Changes sync after a short delay and whenever the server reconnects.'
          )}
        </p>
      </div>
      <SettingsSwitch
        checked={checked}
        disabled={disabled}
        ariaLabelledBy="portable-settings-continuous-sync-label"
        onChange={onChange}
      />
    </div>
  )
}
