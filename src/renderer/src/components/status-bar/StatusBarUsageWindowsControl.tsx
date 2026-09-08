import { SettingsSegmentedControl } from '@/components/settings/SettingsFormControls'
import { translate } from '@/i18n/i18n'
import type { StatusBarUsageWindows } from '../../../../shared/status-bar-usage-windows'

export function StatusBarUsageWindowsControl({
  value,
  onChange
}: {
  value: StatusBarUsageWindows
  onChange: (windows: StatusBarUsageWindows) => void
}): React.JSX.Element {
  return (
    <div className="space-y-1 px-3.5 pb-2.5">
      <span className="text-[11px] text-muted-foreground">
        {translate('statusBar.usageWindows.label', 'Footer windows')}
      </span>
      <SettingsSegmentedControl<StatusBarUsageWindows>
        value={value}
        onChange={onChange}
        ariaLabel={translate('statusBar.usageWindows.label', 'Footer windows')}
        size="sm"
        equalWidth
        options={[
          { value: 'session', label: translate('statusBar.usageWindows.session', '5-hour') },
          { value: 'weekly', label: translate('statusBar.usageWindows.weekly', 'Weekly') },
          { value: 'both', label: translate('statusBar.usageWindows.both', 'Both') }
        ]}
      />
    </div>
  )
}
