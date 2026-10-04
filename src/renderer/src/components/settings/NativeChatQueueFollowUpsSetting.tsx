import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { useStructuredAgentSessionHostQueuesMessages } from '@/runtime/structured-agent-session-host-capability'
import { Label } from '../ui/label'
import { SettingsSwitch } from './SettingsFormControls'

// This screen edits this machine's settings, so it asks this machine's runtime; a paired host that
// predates queueing sends a follow-up right away whatever the switch says.
const STRUCTURED_CHAT_HOST: RuntimeClientTarget = { kind: 'local' }

type NativeChatQueueFollowUpsSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function NativeChatQueueFollowUpsSetting({
  settings,
  updateSettings
}: NativeChatQueueFollowUpsSettingProps): React.JSX.Element | null {
  const hostQueuesMessages = useStructuredAgentSessionHostQueuesMessages(STRUCTURED_CHAT_HOST)
  // A host without the capability ignores the preference; the switch would do nothing.
  if (!hostQueuesMessages) {
    return null
  }
  const queueFollowUpsEnabled = settings.nativeChatQueueFollowUps !== false
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 shrink space-y-0.5">
        <Label>
          {translate('components.settings.nativeChat.queueFollowUpsTitle', 'Queue follow-ups')}
        </Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'components.settings.nativeChat.queueFollowUpsCopy',
            'Messages you send while the agent is working wait as cards you can steer, edit, or delete. Messages with images send right away.'
          )}
        </p>
      </div>
      <SettingsSwitch
        checked={queueFollowUpsEnabled}
        ariaLabel={translate(
          'components.settings.nativeChat.queueFollowUpsToggleLabel',
          'Toggle queue follow-ups'
        )}
        onChange={() => updateSettings({ nativeChatQueueFollowUps: !queueFollowUpsEnabled })}
      />
    </div>
  )
}
