import type React from 'react'
import { useMemo, useState } from 'react'
import { Check, Plus, Trash2, X } from 'lucide-react'
import type { AgentLaunchProfile, GlobalSettings, TuiAgent } from '../../../../shared/types'
import { normalizeAgentLaunchProfiles } from '../../../../shared/agent-launch-profiles'
import { getAgentCatalog, AgentIcon } from '@/lib/agent-catalog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SettingsBadge, SettingsSubsectionHeader } from './SettingsFormControls'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  agentLaunchProfileToDraft,
  buildAgentLaunchProfileFromDraft,
  createAgentLaunchProfileId,
  deleteAgentLaunchProfile,
  EMPTY_PROFILE_DRAFT,
  upsertAgentLaunchProfile,
  type AgentLaunchProfileDraft
} from './agent-launch-profile-draft'

type AgentLaunchProfilesSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

function getAgentLabel(agentId: TuiAgent): string {
  return getAgentCatalog().find((agent) => agent.id === agentId)?.label ?? agentId
}

function ProfileField({
  children,
  label
}: {
  children: React.ReactNode
  label: string
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] font-medium text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

function AgentLaunchProfileEditor({
  draft,
  onChange,
  onDelete,
  onSave,
  profile,
  saveDisabled
}: {
  draft: AgentLaunchProfileDraft
  onChange: (draft: AgentLaunchProfileDraft) => void
  onDelete: () => void
  onSave: () => void
  profile: AgentLaunchProfile
  saveDisabled: boolean
}): React.JSX.Element {
  return (
    <div className="space-y-3 rounded-md border border-border/50 bg-background/50 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <AgentIcon agent={profile.agentId} size={14} />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">
              {getAgentLabel(profile.agentId)}: {profile.name}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">{profile.id}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button type="button" variant="ghost" size="xs" onClick={onSave} disabled={saveDisabled}>
            <Check className="size-3.5" />
            {translate('auto.components.settings.AgentLaunchProfilesSection.save', 'Save')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onDelete}
            aria-label={translate(
              'auto.components.settings.AgentLaunchProfilesSection.deleteProfile',
              'Delete profile'
            )}
            title={translate(
              'auto.components.settings.AgentLaunchProfilesSection.deleteProfile',
              'Delete profile'
            )}
          >
            <Trash2 className="size-3.5 text-destructive" />
          </Button>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <ProfileField
          label={translate('auto.components.settings.AgentLaunchProfilesSection.name', 'Name')}
        >
          <Input
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            placeholder={translate(
              'auto.components.settings.AgentLaunchProfilesSection.work',
              'Work'
            )}
          />
        </ProfileField>
        <ProfileField
          label={translate(
            'auto.components.settings.AgentLaunchProfilesSection.commandOverride',
            'Command override'
          )}
        >
          <Input
            value={draft.commandOverride}
            onChange={(event) => onChange({ ...draft, commandOverride: event.target.value })}
            placeholder={getAgentLabel(profile.agentId).toLowerCase()}
          />
        </ProfileField>
        <ProfileField
          label={translate('auto.components.settings.AgentLaunchProfilesSection.args', 'Args')}
        >
          <Input
            value={draft.args}
            onChange={(event) => onChange({ ...draft, args: event.target.value })}
            placeholder="--profile work"
          />
        </ProfileField>
        <ProfileField
          label={translate('auto.components.settings.AgentLaunchProfilesSection.env', 'Env')}
        >
          <textarea
            value={draft.envText}
            onChange={(event) => onChange({ ...draft, envText: event.target.value })}
            placeholder="CODEX_LOG=info"
            className="min-h-9 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        </ProfileField>
      </div>
    </div>
  )
}

function NewAgentLaunchProfileForm({
  draft,
  onCancel,
  onChange,
  onCreate,
  saveDisabled
}: {
  draft: AgentLaunchProfileDraft
  onCancel: () => void
  onChange: (draft: AgentLaunchProfileDraft) => void
  onCreate: () => void
  saveDisabled: boolean
}): React.JSX.Element {
  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-muted/20 p-3">
      <div className="grid gap-3 md:grid-cols-[180px_1fr]">
        <ProfileField
          label={translate('auto.components.settings.AgentLaunchProfilesSection.agent', 'Agent')}
        >
          <Select
            value={draft.agentId}
            onValueChange={(value) => onChange({ ...draft, agentId: value as TuiAgent })}
          >
            <SelectTrigger aria-label="Profile agent">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {getAgentCatalog().map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ProfileField>
        <ProfileField
          label={translate('auto.components.settings.AgentLaunchProfilesSection.name', 'Name')}
        >
          <Input
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            placeholder={translate(
              'auto.components.settings.AgentLaunchProfilesSection.work',
              'Work'
            )}
          />
        </ProfileField>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <ProfileField
          label={translate(
            'auto.components.settings.AgentLaunchProfilesSection.commandOverride',
            'Command override'
          )}
        >
          <Input
            value={draft.commandOverride}
            onChange={(event) => onChange({ ...draft, commandOverride: event.target.value })}
            placeholder={getAgentCatalog().find((agent) => agent.id === draft.agentId)?.cmd}
          />
        </ProfileField>
        <ProfileField
          label={translate('auto.components.settings.AgentLaunchProfilesSection.args', 'Args')}
        >
          <Input
            value={draft.args}
            onChange={(event) => onChange({ ...draft, args: event.target.value })}
            placeholder="--profile work"
          />
        </ProfileField>
      </div>
      <ProfileField
        label={translate('auto.components.settings.AgentLaunchProfilesSection.env', 'Env')}
      >
        <textarea
          value={draft.envText}
          onChange={(event) => onChange({ ...draft, envText: event.target.value })}
          placeholder="CODEX_LOG=info"
          className="min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </ProfileField>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          <X className="size-3.5" />
          {translate('auto.components.settings.AgentLaunchProfilesSection.cancel', 'Cancel')}
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={onCreate}
          disabled={saveDisabled}
        >
          <Plus className="size-3.5" />
          {translate(
            'auto.components.settings.AgentLaunchProfilesSection.create',
            'Create profile'
          )}
        </Button>
      </div>
    </div>
  )
}

export function AgentLaunchProfilesSection({
  settings,
  updateSettings
}: AgentLaunchProfilesSectionProps): React.JSX.Element {
  const profiles = useMemo(
    () => normalizeAgentLaunchProfiles(settings.agentLaunchProfiles),
    [settings.agentLaunchProfiles]
  )
  const [adding, setAdding] = useState(false)
  const [newDraft, setNewDraft] = useState<AgentLaunchProfileDraft>(EMPTY_PROFILE_DRAFT)
  const [draftsById, setDraftsById] = useState<Record<string, AgentLaunchProfileDraft>>({})
  const profileCountByAgent = useMemo(() => {
    const counts = new Map<TuiAgent, number>()
    for (const profile of profiles) {
      counts.set(profile.agentId, (counts.get(profile.agentId) ?? 0) + 1)
    }
    return counts
  }, [profiles])

  const setProfileDraft = (profileId: string, draft: AgentLaunchProfileDraft): void => {
    setDraftsById((drafts) => ({ ...drafts, [profileId]: draft }))
  }

  const saveProfile = (profile: AgentLaunchProfile): void => {
    const next = buildAgentLaunchProfileFromDraft({
      id: profile.id,
      draft: draftsById[profile.id] ?? agentLaunchProfileToDraft(profile)
    })
    if (!next) {
      return
    }
    void updateSettings({ agentLaunchProfiles: upsertAgentLaunchProfile(profiles, next) })
  }

  const createProfile = (): void => {
    const id = createAgentLaunchProfileId({
      agentId: newDraft.agentId,
      name: newDraft.name,
      profiles
    })
    const profile = buildAgentLaunchProfileFromDraft({ id, draft: newDraft })
    if (!profile) {
      return
    }
    void updateSettings({ agentLaunchProfiles: upsertAgentLaunchProfile(profiles, profile) })
    setNewDraft({ ...EMPTY_PROFILE_DRAFT, agentId: newDraft.agentId })
    setAdding(false)
  }

  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={
          <span className="flex items-center gap-2">
            {translate(
              'auto.components.settings.AgentLaunchProfilesSection.title',
              'Launch Profiles'
            )}
            <SettingsBadge tone="muted">
              {profiles.length}{' '}
              {translate(
                'auto.components.settings.AgentLaunchProfilesSection.profileCount',
                'profiles'
              )}
            </SettingsBadge>
          </span>
        }
        description={translate(
          'auto.components.settings.AgentLaunchProfilesSection.description',
          'Create named variants for built-in agents by changing command, args, and environment.'
        )}
        action={
          <Button type="button" variant="outline" size="xs" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            {translate(
              'auto.components.settings.AgentLaunchProfilesSection.addProfile',
              'Add profile'
            )}
          </Button>
        }
      />
      {adding ? (
        <NewAgentLaunchProfileForm
          draft={newDraft}
          onCancel={() => setAdding(false)}
          onChange={setNewDraft}
          onCreate={createProfile}
          saveDisabled={!newDraft.name.trim()}
        />
      ) : null}
      <div className={cn('space-y-3', profiles.length === 0 && !adding && 'hidden')}>
        {profiles.map((profile) => {
          const draft = draftsById[profile.id] ?? agentLaunchProfileToDraft(profile)
          return (
            <AgentLaunchProfileEditor
              key={profile.id}
              profile={profile}
              draft={draft}
              onChange={(next) => setProfileDraft(profile.id, next)}
              onSave={() => saveProfile(profile)}
              onDelete={() =>
                void updateSettings({
                  agentLaunchProfiles: deleteAgentLaunchProfile(profiles, profile.id)
                })
              }
              saveDisabled={!draft.name.trim()}
            />
          )
        })}
      </div>
      {profiles.length === 0 && !adding ? (
        <div className="rounded-md border border-dashed border-border/60 px-3 py-4 text-sm text-muted-foreground">
          {translate(
            'auto.components.settings.AgentLaunchProfilesSection.empty',
            'No launch profiles yet.'
          )}
        </div>
      ) : null}
      {profileCountByAgent.size > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {[...profileCountByAgent.entries()].map(([agentId, count]) => (
            <SettingsBadge key={agentId} tone="neutral">
              <AgentIcon agent={agentId} size={12} />
              {getAgentLabel(agentId)}: {count}
            </SettingsBadge>
          ))}
        </div>
      ) : null}
    </section>
  )
}
