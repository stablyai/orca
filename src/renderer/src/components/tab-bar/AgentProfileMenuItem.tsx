import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { AgentLaunchProfile } from '../../../../shared/agent-launch-profile'
import { AgentIcon } from '@/lib/agent-catalog'
import { useStructuredAgentLaunchStatus } from '@/lib/structured-agent-session-launch-status'
import { DropdownMenuItem } from '../ui/dropdown-menu'
export function AgentProfileMenuItem({
  profile,
  worktreeId,
  label,
  disabled,
  onSelect
}: {
  profile: AgentLaunchProfile
  worktreeId: string
  label?: string
  disabled: boolean
  onSelect: () => void
}) {
  const pending = useStructuredAgentLaunchStatus(worktreeId, profile.agent, profile) === 'pending'
  return (
    <DropdownMenuItem disabled={disabled || pending} onSelect={onSelect}>
      {pending ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <AgentIcon agent={profile.agent} size={14} />
      )}
      <span className="flex-1">{profile.name}</span>
      <span className="truncate text-xs text-muted-foreground">
        {profile.binding.kind === 'external'
          ? translate('agentProfiles.unverified', 'Unverified configuration')
          : (label ??
            translate('agentProfiles.unavailable', 'Account unavailable — edit to reconnect'))}
      </span>
    </DropdownMenuItem>
  )
}
