import { ChevronDown } from 'lucide-react'
import {
  DEFAULT_BOUNDED_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MAX_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MIN_SSH_RELAY_GRACE_PERIOD_SECONDS
} from '../../../../shared/ssh-types'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { SettingsSwitch } from './SettingsFormControls'
import type { EditingTarget, SshRemoteRuntimeChoice } from './ssh-target-draft'
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
          <SshRemoteRuntimeField
            value={form.remoteRuntime}
            disabled={disabled}
            onChange={(remoteRuntime) => onFormChange((f) => ({ ...f, remoteRuntime }))}
          />
          <div className="flex items-start justify-between gap-4 py-1 text-xs">
            <div className="min-w-0 flex-1 space-y-0.5">
              <Label className="text-xs font-medium">
                {translate(
                  'auto.components.settings.SshTargetForm.71fc546097',
                  'Keep terminals alive until reset'
                )}
              </Label>
              <p className="text-muted-foreground">
                {translate(
                  'auto.components.settings.SshTargetForm.b574994adc',
                  'Use End Remote Terminals or Reset Relay when you want to stop them.'
                )}
              </p>
            </div>
            <SettingsSwitch
              checked={form.relayKeepAliveUntilReset}
              disabled={disabled}
              onChange={() =>
                onFormChange((f) => ({
                  ...f,
                  relayKeepAliveUntilReset: !f.relayKeepAliveUntilReset
                }))
              }
              ariaLabel={translate(
                'auto.components.settings.SshTargetForm.71fc546097',
                'Keep terminals alive until reset'
              )}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="add-ssh-relay-grace-period" className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.SshTargetForm.55c56cf2c7',
                'Timeout after disconnect (seconds)'
              )}
            </Label>
            <Input
              id="add-ssh-relay-grace-period"
              type={form.relayKeepAliveUntilReset ? 'text' : 'number'}
              value={
                form.relayKeepAliveUntilReset
                  ? translate('auto.components.settings.SshTargetForm.7c13f58c91', 'Until reset')
                  : form.relayGracePeriodSeconds
              }
              disabled={disabled || form.relayKeepAliveUntilReset}
              onChange={(e) =>
                onFormChange((f) => ({ ...f, relayGracePeriodSeconds: e.target.value }))
              }
              placeholder={String(DEFAULT_BOUNDED_SSH_RELAY_GRACE_PERIOD_SECONDS)}
              min={MIN_SSH_RELAY_GRACE_PERIOD_SECONDS}
              max={MAX_SSH_RELAY_GRACE_PERIOD_SECONDS}
            />
            <p className="text-[11px] text-muted-foreground">
              {translate(
                'auto.components.settings.SshTargetForm.1b19b00e93',
                'Bounded timeouts must be between 60 seconds and 7 days.'
              )}
            </p>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

const REMOTE_RUNTIME_CHOICES: readonly SshRemoteRuntimeChoice[] = ['auto', 'pinned-node', 'legacy']

function isRemoteRuntimeChoice(value: string): value is SshRemoteRuntimeChoice {
  return REMOTE_RUNTIME_CHOICES.some((choice) => choice === value)
}

// Why three choices over two stored values: Auto stores nothing, so the host follows the
// default when it moves to Orca-managed Node; Host Node pins today's host-npm relay.
function SshRemoteRuntimeField({
  value,
  disabled,
  onChange
}: {
  value: SshRemoteRuntimeChoice
  disabled: boolean
  onChange: (value: SshRemoteRuntimeChoice) => void
}): React.JSX.Element {
  const label = translate('auto.components.settings.SshTargetForm.remoteRuntime', 'Runtime')
  return (
    <div className="flex items-start justify-between gap-4 py-1 text-xs">
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>{label}</Label>
        <p className="text-muted-foreground">
          {translate(
            'auto.components.settings.SshTargetForm.remoteRuntimeHelp',
            'Which Node.js runs Orca on this host. Orca-managed Node uploads its own and needs no npm; Host Node uses the Node.js already installed there.'
          )}
        </p>
      </div>
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (isRemoteRuntimeChoice(next)) {
            onChange(next)
          }
        }}
      >
        <SelectTrigger size="sm" className="w-[168px]" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">
            {translate('auto.components.settings.SshTargetForm.remoteRuntimeAuto', 'Auto')}
          </SelectItem>
          <SelectItem value="pinned-node">
            {translate(
              'auto.components.settings.SshTargetForm.remoteRuntimePinnedNode',
              'Orca-managed Node'
            )}
          </SelectItem>
          <SelectItem value="legacy">
            {translate('auto.components.settings.SshTargetForm.remoteRuntimeHostNode', 'Host Node')}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}
