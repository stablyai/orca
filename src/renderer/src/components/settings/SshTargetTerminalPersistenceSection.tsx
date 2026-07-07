import {
  DEFAULT_BOUNDED_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MAX_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MIN_SSH_RELAY_GRACE_PERIOD_SECONDS
} from '../../../../shared/ssh-types'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SettingsSwitch } from './SettingsFormControls'
import { SshTargetFormCollapsibleSection } from './SshTargetFormCollapsibleSection'
import type { EditingTarget } from './ssh-target-draft'
import { translate } from '@/i18n/i18n'

type SshTargetTerminalPersistenceSectionProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  form: EditingTarget
  onFormChange: (updater: (prev: EditingTarget) => EditingTarget) => void
}

export function SshTargetTerminalPersistenceSection({
  open,
  onOpenChange,
  form,
  onFormChange
}: SshTargetTerminalPersistenceSectionProps): React.JSX.Element {
  return (
    <SshTargetFormCollapsibleSection
      open={open}
      onOpenChange={onOpenChange}
      title={translate(
        'auto.components.settings.SshTargetForm.92f80edbfd',
        'Remote Terminal Persistence'
      )}
      description={translate(
        'auto.components.settings.SshTargetForm.137e88ce8d',
        'Remote terminals keep running after Orca disconnects from this host.'
      )}
    >
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
        <Label htmlFor="ssh-relay-grace-period" className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.SshTargetForm.55c56cf2c7',
            'Timeout after disconnect (seconds)'
          )}
        </Label>
        <Input
          id="ssh-relay-grace-period"
          type={form.relayKeepAliveUntilReset ? 'text' : 'number'}
          value={
            form.relayKeepAliveUntilReset
              ? translate('auto.components.settings.SshTargetForm.7c13f58c91', 'Until reset')
              : form.relayGracePeriodSeconds
          }
          onChange={(e) => onFormChange((f) => ({ ...f, relayGracePeriodSeconds: e.target.value }))}
          placeholder={String(DEFAULT_BOUNDED_SSH_RELAY_GRACE_PERIOD_SECONDS)}
          min={MIN_SSH_RELAY_GRACE_PERIOD_SECONDS}
          max={MAX_SSH_RELAY_GRACE_PERIOD_SECONDS}
          disabled={form.relayKeepAliveUntilReset}
        />
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'auto.components.settings.SshTargetForm.1b19b00e93',
            'Bounded timeouts must be between 60 seconds and 7 days.'
          )}
        </p>
      </div>
    </SshTargetFormCollapsibleSection>
  )
}
