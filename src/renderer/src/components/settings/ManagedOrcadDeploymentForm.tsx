import { Loader2, ServerCog } from 'lucide-react'
import type { SshTarget } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { ManagedOrcadMigrationPreflight } from './ManagedOrcadMigrationPreflight'
import type {
  ManagedOrcadBusyAction,
  ManagedOrcadTargetPreflightEntry
} from './use-managed-orcad-servers'

type ManagedOrcadDeploymentFormProps = {
  busyAction: ManagedOrcadBusyAction | null
  error: string | null
  name: string
  onCancel: () => void
  onDeploy: (input: { name: string; sshTargetId: string }) => void
  onErrorClear: () => void
  onNameChange: (value: string) => void
  onTargetChange: (value: string) => void
  preflight: ManagedOrcadTargetPreflightEntry | null
  sshTargetId: string
  targets: SshTarget[]
}

export function ManagedOrcadDeploymentForm({
  busyAction,
  error,
  name,
  onCancel,
  onDeploy,
  onErrorClear,
  onNameChange,
  onTargetChange,
  preflight,
  sshTargetId,
  targets
}: ManagedOrcadDeploymentFormProps): React.JSX.Element {
  const selectedTargetId = targets.some((target) => target.id === sshTargetId) ? sshTargetId : ''
  const busy = busyAction !== null
  const preflightAllowsDeploy =
    preflight?.state === 'ready' &&
    preflight.targetId === selectedTargetId &&
    preflight.preflight.claimable
  return (
    <form
      className="space-y-3 rounded-lg border border-border/50 bg-card/30 p-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (name.trim() && selectedTargetId && preflightAllowsDeploy) {
          onDeploy({ name: name.trim(), sshTargetId: selectedTargetId })
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <div className="space-y-1">
            <Label htmlFor="managed-orcad-name">
              {translate(
                'auto.components.settings.ManagedOrcadServersSection.serverName',
                'Server name'
              )}
            </Label>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.ManagedOrcadServersSection.serverNameHelp',
                'The name shown in Orca host selectors.'
              )}
            </p>
          </div>
          <Input
            id="managed-orcad-name"
            value={name}
            onChange={(event) => {
              onNameChange(event.target.value)
              onErrorClear()
            }}
            autoFocus
            disabled={busy}
            aria-invalid={error ? true : undefined}
          />
        </div>
        <div className="space-y-2">
          <div className="space-y-1">
            <Label id="managed-orcad-target-label">
              {translate(
                'auto.components.settings.ManagedOrcadServersSection.sshTarget',
                'SSH host'
              )}
            </Label>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.ManagedOrcadServersSection.sshTargetHelp',
                'Only unowned SSH targets are available.'
              )}
            </p>
          </div>
          <Select
            value={selectedTargetId}
            onValueChange={(value) => {
              onTargetChange(value)
              onErrorClear()
            }}
            disabled={busy || targets.length === 0}
          >
            <SelectTrigger aria-labelledby="managed-orcad-target-label">
              <SelectValue
                placeholder={translate(
                  'auto.components.settings.ManagedOrcadServersSection.chooseSshTarget',
                  'Choose an SSH host'
                )}
              />
            </SelectTrigger>
            <SelectContent>
              {targets.map((target) => (
                <SelectItem key={target.id} value={target.id}>
                  {target.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {targets.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.ManagedOrcadServersSection.noSshTargets',
            'No available SSH hosts. Add one in SSH settings first.'
          )}
        </p>
      ) : null}
      <ManagedOrcadMigrationPreflight entry={preflight} targetId={selectedTargetId} />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {translate('auto.components.settings.ManagedOrcadServersSection.cancel', 'Cancel')}
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={busy || !name.trim() || !selectedTargetId || !preflightAllowsDeploy}
        >
          {busyAction?.id === 'create' ? <Loader2 className="animate-spin" /> : <ServerCog />}
          {busyAction?.id === 'create'
            ? translate(
                'auto.components.settings.ManagedOrcadServersSection.deploying',
                'Deploying…'
              )
            : translate('auto.components.settings.ManagedOrcadServersSection.deploy', 'Deploy')}
        </Button>
      </div>
    </form>
  )
}
