import type { AgentCommandProfile } from '../../../../shared/agent-command-profile'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'

const DEFAULT_PROFILE_VALUE = '__default__'

/** Picks which named command profile (see agentCommandProfiles) to launch the
 *  currently selected agent with. Only rendered when the agent has at least
 *  one extra profile configured in Settings → Agents. */
export function AgentProfileSelect({
  profiles,
  value,
  onValueChange
}: {
  profiles: readonly AgentCommandProfile[]
  value: string | null
  onValueChange: (profileId: string | null) => void
}): React.JSX.Element {
  return (
    <Select
      value={value ?? DEFAULT_PROFILE_VALUE}
      onValueChange={(next) => onValueChange(next === DEFAULT_PROFILE_VALUE ? null : next)}
    >
      <SelectTrigger
        size="sm"
        className="mt-1.5 h-8 w-full min-w-0 border-input text-xs"
        aria-label={translate(
          'auto.components.agent.AgentProfileSelect.label',
          'Command profile'
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_PROFILE_VALUE}>
          {translate('auto.components.agent.AgentProfileSelect.default', 'Default command')}
        </SelectItem>
        {profiles.map((profile) => (
          <SelectItem key={profile.id} value={profile.id}>
            {profile.label || profile.cmd}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
