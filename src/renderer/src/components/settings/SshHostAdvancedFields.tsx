import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { SettingsSwitch } from './SettingsFormControls'
import type { EditingTarget } from './ssh-target-draft'
import { translate } from '@/i18n/i18n'

// Why: mirror the composer's "Advanced" disclosure (ghost button + rotating chevron) so the
// add-host dialog reads the same, while reusing the exact field labels/help text from the
// Settings SSH form (proxy, jump host, connection reuse, terminal persistence).
export function SshHostAdvancedFields({
  open,
  onOpenChange,
  form,
  disabled,
  onFormChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  form: EditingTarget
  disabled: boolean
  onFormChange: (updater: (prev: EditingTarget) => EditingTarget) => void
}): React.JSX.Element {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="col-span-2 sm:col-span-2">
      <CollapsibleTrigger asChild>
        {/* Why: no negative margin — the button's highlight would overhang and get clipped by the
            dialog/settings containers. A small left padding keeps it flush without overflow. */}
        <Button type="button" variant="ghost" size="sm" className="px-2 text-xs">
          {translate('auto.components.sidebar.AddRemoteHostDialog.advanced', 'Advanced')}
          <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-height-content">
        <div className="space-y-4 pt-3">
          <div className="space-y-1.5">
            <Label htmlFor="add-ssh-proxy-command">
              {translate('auto.components.settings.SshTargetForm.c7d0e18ecb', 'Proxy Command')}
            </Label>
            <Input
              id="add-ssh-proxy-command"
              value={form.proxyCommand}
              disabled={disabled}
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
            <Label htmlFor="add-ssh-jump-host">
              {translate('auto.components.settings.SshTargetForm.b2ab248ded', 'Jump Host')}
            </Label>
            <Input
              id="add-ssh-jump-host"
              value={form.jumpHost}
              disabled={disabled}
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
              disabled={disabled}
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
          <div className="flex items-start justify-between gap-4 py-1 text-xs">
            <div className="min-w-0 flex-1 space-y-0.5">
              <Label className="text-xs font-medium">
                {translate(
                  'auto.components.settings.SshTargetForm.allowRemoteCliControl',
                  "Allow this host's orca CLI to control Orca"
                )}
              </Label>
              <p className="text-muted-foreground">
                {translate(
                  'auto.components.settings.SshTargetForm.allowRemoteCliControlHelp',
                  'When off, orca commands run on this host reach only its own terminals. Turn on to let them reach other hosts, orchestration, files, and integrations on this computer.'
                )}
              </p>
            </div>
            <SettingsSwitch
              checked={form.allowRemoteCliControl}
              disabled={disabled}
              onChange={() =>
                onFormChange((f) => ({
                  ...f,
                  allowRemoteCliControl: !f.allowRemoteCliControl
                }))
              }
              ariaLabel={translate(
                'auto.components.settings.SshTargetForm.allowRemoteCliControl',
                "Allow this host's orca CLI to control Orca"
              )}
            />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
