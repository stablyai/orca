import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SettingsSwitch } from './SettingsFormControls'
import { SshTargetFormCollapsibleSection } from './SshTargetFormCollapsibleSection'
import type { EditingTarget } from './ssh-target-draft'
import { translate } from '@/i18n/i18n'

type SshTargetAdvancedConnectionSectionProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  form: EditingTarget
  onFormChange: (updater: (prev: EditingTarget) => EditingTarget) => void
}

export function SshTargetAdvancedConnectionSection({
  open,
  onOpenChange,
  form,
  onFormChange
}: SshTargetAdvancedConnectionSectionProps): React.JSX.Element {
  return (
    <SshTargetFormCollapsibleSection
      open={open}
      onOpenChange={onOpenChange}
      title={translate('auto.components.settings.SshTargetForm.4a342f44c1', 'Advanced Connection')}
      description={translate(
        'auto.components.settings.SshTargetForm.e9609ddca6',
        'Proxy, jump host, and connection reuse'
      )}
    >
      <div className="space-y-1.5">
        <Label>
          {translate('auto.components.settings.SshTargetForm.c7d0e18ecb', 'Proxy Command')}
        </Label>
        <Input
          value={form.proxyCommand}
          onChange={(e) => onFormChange((f) => ({ ...f, proxyCommand: e.target.value }))}
          placeholder={translate(
            'auto.components.settings.SshTargetForm.f42d844544',
            'e.g. cloudflared access ssh --hostname %h'
          )}
        />
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'auto.components.settings.SshTargetForm.3b01ca44a0',
            'Optional. Used for tunneling (e.g. Cloudflare Access, ProxyCommand).'
          )}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label>{translate('auto.components.settings.SshTargetForm.b2ab248ded', 'Jump Host')}</Label>
        <Input
          value={form.jumpHost}
          onChange={(e) => onFormChange((f) => ({ ...f, jumpHost: e.target.value }))}
          placeholder={translate(
            'auto.components.settings.SshTargetForm.11bcb4507a',
            'bastion.example.com'
          )}
        />
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'auto.components.settings.SshTargetForm.feae1d1e69',
            'Optional. Equivalent to ProxyJump / ssh -J.'
          )}
        </p>
      </div>
      <div className="flex items-start justify-between gap-4 py-1 text-xs">
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label className="text-xs font-medium">
            {translate(
              'auto.components.settings.SshTargetForm.8c922dffba',
              'Reuse SSH connection for faster setup'
            )}
          </Label>
          <p className="text-muted-foreground">
            {translate(
              'auto.components.settings.SshTargetForm.53e9aabfc0',
              'Uses OpenSSH multiplexing when available. Turn off for hosts with custom SSH restrictions.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={form.systemSshConnectionReuse}
          onChange={() =>
            onFormChange((f) => ({
              ...f,
              systemSshConnectionReuse: !f.systemSshConnectionReuse
            }))
          }
          ariaLabel={translate(
            'auto.components.settings.SshTargetForm.8c922dffba',
            'Reuse SSH connection for faster setup'
          )}
        />
      </div>
    </SshTargetFormCollapsibleSection>
  )
}

export function hasAdvancedConnectionValues(form: EditingTarget): boolean {
  return (
    form.proxyCommand.trim().length > 0 ||
    form.jumpHost.trim().length > 0 ||
    !form.systemSshConnectionReuse
  )
}
