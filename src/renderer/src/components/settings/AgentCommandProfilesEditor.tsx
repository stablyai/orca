import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import type { AgentCommandProfile } from '../../../../shared/agent-command-profile'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { translate } from '@/i18n/i18n'

function createProfileId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function AgentCommandProfileRow({
  profile,
  onChange,
  onRemove
}: {
  profile: AgentCommandProfile
  onChange: (next: AgentCommandProfile) => void
  onRemove: () => void
}): React.JSX.Element {
  const [labelDraft, setLabelDraft] = useState(profile.label)
  const [cmdDraft, setCmdDraft] = useState(profile.cmd)

  return (
    <div className="flex items-center gap-2">
      <Input
        value={labelDraft}
        onChange={(event) => setLabelDraft(event.target.value)}
        onBlur={() => onChange({ ...profile, label: labelDraft.trim() })}
        placeholder={translate('auto.components.settings.AgentsPane.profileLabel', 'Name')}
        spellCheck={false}
        className="h-7 w-32 shrink-0 text-xs"
      />
      <Input
        value={cmdDraft}
        onChange={(event) => setCmdDraft(event.target.value)}
        onBlur={() => onChange({ ...profile, cmd: cmdDraft.trim() })}
        placeholder={translate('auto.components.settings.AgentsPane.profileCmd', 'Command')}
        spellCheck={false}
        className="h-7 flex-1 font-mono text-xs"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onRemove}
        aria-label={translate(
          'auto.components.settings.AgentsPane.removeProfile',
          'Remove profile'
        )}
        className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
      >
        <X className="size-3.5" />
      </Button>
    </div>
  )
}

export function AgentCommandProfilesEditor({
  profiles,
  onSaveProfiles
}: {
  profiles: AgentCommandProfile[]
  onSaveProfiles: (next: AgentCommandProfile[]) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.AgentsPane.commandProfiles',
          'Command profiles'
        )}
      </span>
      {profiles.map((profile) => (
        <AgentCommandProfileRow
          key={profile.id}
          profile={profile}
          onChange={(next) =>
            onSaveProfiles(profiles.map((entry) => (entry.id === next.id ? next : entry)))
          }
          onRemove={() => onSaveProfiles(profiles.filter((entry) => entry.id !== profile.id))}
        />
      ))}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() =>
          onSaveProfiles([...profiles, { id: createProfileId(), label: '', cmd: '' }])
        }
        className="h-7 w-fit gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <Plus className="size-3" />
        {translate('auto.components.settings.AgentsPane.addProfile', 'Add profile')}
      </Button>
      <p className="text-[11px] text-muted-foreground">
        {translate(
          'auto.components.settings.AgentsPane.commandProfilesHint',
          'Extra named commands for this agent (e.g. a second account or wrapper). Pick one when starting a new session.'
        )}
      </p>
    </div>
  )
}
