import { useState } from 'react'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { translate } from '@/i18n/i18n'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  INITIAL_WORKER_ROLE_NAMES,
  WorkerRoleName,
  parseWorkerRoleProfiles,
  type WorkerRoleProfile
} from '../../../../shared/orchestration-worker-roles'
import { Label } from '../ui/label'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { WorkerRoleProfileEditor } from './WorkerRoleProfileEditor'
import { nativeChatPreferenceFor } from '../../../../shared/structured-native-chat-launch-route'

export function WorkerRoleSettings({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const { detectedIds } = useDetectedAgents({ kind: 'local' })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newRole, setNewRole] = useState('')
  const [draftRoles, setDraftRoles] = useState<string[]>([])
  const profiles = settings.orchestrationWorkerRoles ?? {}
  const roles = [
    ...new Set([...INITIAL_WORKER_ROLE_NAMES, ...Object.keys(profiles), ...draftRoles])
  ]
  const save = async (role: string, profile: WorkerRoleProfile | undefined) => {
    setPending(true)
    setError(null)
    try {
      const next = { ...profiles }
      if (profile) {
        next[role] = profile
      } else {
        delete next[role]
      }
      await updateSettings({ orchestrationWorkerRoles: parseWorkerRoleProfiles(next) })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setPending(false)
    }
  }

  return (
    <section
      className="space-y-4"
      aria-label={translate('settings.orchestration.roles.title', 'Worker roles')}
    >
      <div className="space-y-1">
        <h3 className="text-sm font-medium">
          {translate('settings.orchestration.roles.title', 'Worker roles')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'settings.orchestration.roles.description',
            'Choose which agent handles each role, with a model and reasoning level for each. These profiles are saved on this Orca host.'
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {translate(
            'settings.orchestration.roles.catalog',
            'Agents keep their configured commands and permissions. Fast availability depends on the provider, account and workspace.'
          )}
        </p>
      </div>
      {roles.map((role) => (
        <div key={role} className="space-y-3 border-t border-border pt-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">
              {role === 'research'
                ? translate('settings.orchestration.roles.research', 'Research')
                : role === 'implementation'
                  ? translate('settings.orchestration.roles.implementation', 'Implementation')
                  : role === 'review'
                    ? translate('settings.orchestration.roles.review', 'Review')
                    : role}
            </span>
            {profiles[role] ? (
              <Button
                variant="ghost"
                size="xs"
                disabled={pending}
                onClick={() => void save(role, undefined)}
              >
                {translate('settings.orchestration.roles.clear', 'Clear profile')}
              </Button>
            ) : null}
          </div>
          <WorkerRoleProfileEditor
            role={role}
            profile={profiles[role]}
            disabled={pending}
            disabledAgents={settings.disabledTuiAgents}
            detectedIds={detectedIds}
            structuredFast={
              (profiles[role]?.agent === 'claude' || profiles[role]?.agent === 'codex') &&
              nativeChatPreferenceFor(settings, profiles[role].agent)
            }
            onChange={(profile) => void save(role, profile)}
          />
        </div>
      ))}
      <div className="space-y-2">
        <Label htmlFor="new-worker-role">
          {translate('settings.orchestration.roles.new', 'Add a role')}
        </Label>
        <div className="flex gap-2">
          <Input
            id="new-worker-role"
            value={newRole}
            disabled={pending || roles.length >= 24}
            onChange={(event) => setNewRole(event.target.value)}
            aria-invalid={Boolean(newRole && !WorkerRoleName.safeParse(newRole).success)}
          />
          <Button
            variant="outline"
            disabled={
              pending ||
              roles.length >= 24 ||
              !WorkerRoleName.safeParse(newRole).success ||
              roles.includes(newRole)
            }
            onClick={() => {
              setDraftRoles((current) => [...current, newRole])
              setNewRole('')
            }}
          >
            {translate('settings.orchestration.roles.add', 'Add')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'settings.orchestration.roles.nameHint',
            'Use lowercase letters, digits and hyphens. Select an agent to save the role.'
          )}
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  )
}
