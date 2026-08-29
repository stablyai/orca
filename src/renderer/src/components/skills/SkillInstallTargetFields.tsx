import { useEffect, useId, useState } from 'react'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { SKILL_INSTALL_CAPABILITY } from '../../../../shared/skill-install-capability'
import type { SkillInstallProviderId } from '../../../../shared/skill-install-providers'
import { SkillInstallAgentPicker } from './SkillInstallAgentPicker'
import { SkillInstallWorkspaceCombobox } from './SkillInstallWorkspaceCombobox'
import type { SkillInstallWorkspaceChoice } from './skill-install-workspace-choices'
import { translate } from '@/i18n/i18n'

export function SkillInstallTargetFields(props: {
  environmentId: string
  onEnvironmentChange(value: string): void
  scope: 'global' | 'workspace'
  onScopeChange(value: 'global' | 'workspace'): void
  workspace: string
  onWorkspaceChange(value: string): void
  executionTarget: { kind: 'wsl'; distro: string } | null
  onExecutionTargetChange(value: { kind: 'wsl'; distro: string } | null): void
  runtimeEnvironments: readonly { id: string; name: string }[]
  runtimeStatus: Map<string, { status: { capabilities?: string[] } | null }>
  sshConnections: readonly { id: string; label: string; connected: boolean }[]
  workspaceChoices: readonly SkillInstallWorkspaceChoice[]
  requiredCapability?: string
  providers: ReadonlySet<SkillInstallProviderId>
  detectedAgents: readonly string[] | null
  onProvidersChange(next: Set<SkillInstallProviderId>): void
  busy?: boolean
}): React.JSX.Element {
  const [wslDistros, setWslDistros] = useState<string[]>([])
  const fieldId = useId()

  useEffect(() => {
    let active = true
    if (props.environmentId.startsWith('ssh:')) {
      setWslDistros([])
      return () => {
        active = false
      }
    }
    void window.api.skills
      .listWslDistros(props.environmentId === 'local' ? undefined : props.environmentId)
      .then((distros) => {
        if (active) {
          setWslDistros(distros)
        }
      })
      .catch(() => {
        if (active) {
          setWslDistros([])
        }
      })
    return () => {
      active = false
    }
  }, [props.environmentId])

  return (
    <>
      <section className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${fieldId}-machine`}>
            {translate('auto.components.skills.SkillInstallTargetFields.b8a0b706ad', 'Machine')}
          </Label>
          <Select
            value={props.environmentId}
            onValueChange={(value) => {
              props.onEnvironmentChange(value)
              props.onWorkspaceChange('')
              props.onExecutionTargetChange(null)
            }}
          >
            <SelectTrigger id={`${fieldId}-machine`} className="w-full min-w-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="local">
                {translate(
                  'auto.components.skills.SkillInstallTargetFields.8562dd1e6e',
                  'This computer'
                )}
              </SelectItem>
              {props.runtimeEnvironments.map((environment) => {
                const status = props.runtimeStatus.get(environment.id)?.status
                const unsupported =
                  status !== null &&
                  status !== undefined &&
                  status.capabilities?.includes(
                    props.requiredCapability ?? SKILL_INSTALL_CAPABILITY
                  ) !== true
                return (
                  <SelectItem key={environment.id} value={environment.id} disabled={unsupported}>
                    {environment.name}{' '}
                    {unsupported
                      ? translate(
                          'auto.components.skills.SkillInstallTargetFields.0785d0a503',
                          '— update required'
                        )
                      : ''}
                  </SelectItem>
                )
              })}
              {props.sshConnections.map((connection) => (
                <SelectItem
                  key={`ssh:${connection.id}`}
                  value={`ssh:${connection.id}`}
                  disabled={!connection.connected}
                >
                  {connection.label}{' '}
                  {!connection.connected
                    ? translate(
                        'auto.components.skills.SkillInstallTargetFields.71eefd7660',
                        '— disconnected'
                      )
                    : translate(
                        'auto.components.skills.SkillInstallTargetFields.85d85880df',
                        '· SSH'
                      )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${fieldId}-destination`}>
            {translate('auto.components.skills.SkillInstallTargetFields.63cc9e31fe', 'Destination')}
          </Label>
          <Select
            value={props.scope}
            onValueChange={(value) => props.onScopeChange(value as 'global' | 'workspace')}
          >
            <SelectTrigger id={`${fieldId}-destination`} className="w-full min-w-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="global">
                {translate(
                  'auto.components.skills.SkillInstallTargetFields.c779621aa0',
                  'Global skills'
                )}
              </SelectItem>
              <SelectItem value="workspace">
                {translate(
                  'auto.components.skills.SkillInstallTargetFields.a4dfd33095',
                  'One workspace'
                )}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </section>

      {props.scope === 'global' && wslDistros.length > 0 ? (
        <section className="space-y-2">
          <Label htmlFor={`${fieldId}-execution`}>
            {translate(
              'auto.components.skills.SkillInstallTargetFields.cb47652227',
              'Execution environment'
            )}
          </Label>
          <Select
            value={props.executionTarget?.distro ?? 'host'}
            onValueChange={(value) =>
              props.onExecutionTargetChange(
                value === 'host' ? null : { kind: 'wsl', distro: value }
              )
            }
          >
            <SelectTrigger id={`${fieldId}-execution`} className="w-full min-w-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="host">
                {translate(
                  'auto.components.skills.SkillInstallTargetFields.e5b0d15e64',
                  'Host operating system'
                )}
              </SelectItem>
              {wslDistros.map((distro) => (
                <SelectItem key={distro} value={distro}>
                  {translate('auto.components.skills.SkillInstallTargetFields.0c10a406fb', 'WSL ·')}{' '}
                  {distro}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </section>
      ) : null}

      {props.scope === 'workspace' ? (
        <section className="space-y-2">
          <Label htmlFor={`${fieldId}-workspace`}>
            {translate('auto.components.skills.SkillInstallTargetFields.0e5b43a9e3', 'Workspace')}
          </Label>
          <SkillInstallWorkspaceCombobox
            id={`${fieldId}-workspace`}
            value={props.workspace}
            onValueChange={props.onWorkspaceChange}
            choices={props.workspaceChoices}
            disabled={props.busy}
          />
          {props.workspaceChoices.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.skills.SkillInstallTargetFields.8e6a972229',
                'No workspaces are known on this machine.'
              )}
            </p>
          ) : null}
        </section>
      ) : null}

      <SkillInstallAgentPicker
        id={`${fieldId}-agents`}
        scope={props.scope}
        selected={props.providers}
        detectedAgents={props.detectedAgents}
        busy={props.busy === true}
        onChange={props.onProvidersChange}
      />
    </>
  )
}
