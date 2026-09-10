import type { AgentNotificationMode } from '../../../../shared/notification-settings-types'
import { isAgentNotificationMode } from '../../../../shared/agent-notification-policy'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { translate } from '@/i18n/i18n'

type AgentNotificationModeSettingProps = {
  value: AgentNotificationMode
  disabled: boolean
  onChange: (value: AgentNotificationMode) => void
}

export function AgentNotificationModeSetting({
  value,
  disabled,
  onChange
}: AgentNotificationModeSettingProps): React.JSX.Element {
  return (
    <div className="space-y-2 py-2 pl-6">
      <div className="space-y-1">
        <Label>
          {translate(
            'auto.components.settings.AgentNotificationModeSetting.label',
            'Agent notification mode'
          )}
        </Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.AgentNotificationModeSetting.description',
            'Choose whether intermediate agent activity should request your attention.'
          )}
        </p>
      </div>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(nextValue) => {
          if (isAgentNotificationMode(nextValue)) {
            onChange(nextValue)
          }
        }}
      >
        <SelectTrigger
          size="sm"
          className="w-full max-w-72"
          aria-label={translate(
            'auto.components.settings.AgentNotificationModeSetting.label',
            'Agent notification mode'
          )}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">
            {translate(
              'auto.components.settings.AgentNotificationModeSetting.all',
              'All completions and attention'
            )}
          </SelectItem>
          <SelectItem value="results-and-actions">
            {translate(
              'auto.components.settings.AgentNotificationModeSetting.resultsAndActions',
              'Results and action required'
            )}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}
