import { Terminal } from 'lucide-react'
import type { TuiAgent } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { Label } from '../ui/label'
import { SettingsSwitch } from './SettingsFormControls'
import { cn } from '@/lib/utils'

export function RuntimeSettingsSyncAgentsSection({
  installable,
  manualOnly,
  selected,
  enabled,
  applying,
  onEnabledChange,
  onSelectedChange
}: {
  installable: readonly TuiAgent[]
  manualOnly: readonly TuiAgent[]
  selected: ReadonlySet<TuiAgent>
  enabled: boolean
  applying: boolean
  onEnabledChange: (enabled: boolean) => void
  onSelectedChange: (agent: TuiAgent, checked: boolean) => void
}): React.JSX.Element | null {
  if (installable.length === 0 && manualOnly.length === 0) {
    return (
      <div className="rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.RuntimeSettingsSyncDialog.agentsAllPresent',
          'All of your local agent CLIs are already available on this server.'
        )}
      </div>
    )
  }

  const catalogById = new Map(getAgentCatalog().map((entry) => [entry.id, entry] as const))

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
      {installable.length > 0 ? (
        <>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label
                id="portable-settings-install-agents-label"
                className="flex items-center gap-1.5 text-sm font-medium"
              >
                <Terminal className="size-3.5" />
                {translate(
                  'auto.components.settings.RuntimeSettingsSyncDialog.installAgents',
                  'Also install missing agent CLIs'
                )}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.RuntimeSettingsSyncDialog.installAgentsHelp',
                  'Installs public CLI packages on the server. Does not copy logins or credentials — sign in on the remote when you first launch each agent.'
                )}
              </p>
            </div>
            <SettingsSwitch
              checked={enabled}
              disabled={applying}
              ariaLabelledBy="portable-settings-install-agents-label"
              onChange={() => onEnabledChange(!enabled)}
            />
          </div>

          <ul className={cn('space-y-1.5', !enabled && 'opacity-50')}>
            {installable.map((agent) => {
              const label = catalogById.get(agent)?.label ?? agent
              const checked = selected.has(agent)
              return (
                <li key={agent}>
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-3.5 accent-primary"
                      checked={checked}
                      disabled={applying || !enabled}
                      onChange={(event) => onSelectedChange(agent, event.target.checked)}
                    />
                    <span>{label}</span>
                  </label>
                </li>
              )
            })}
          </ul>
        </>
      ) : null}

      {manualOnly.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RuntimeSettingsSyncDialog.agentsManualOnly',
            'Also missing (install manually): {{value0}}',
            {
              value0: manualOnly.map((agent) => catalogById.get(agent)?.label ?? agent).join(', ')
            }
          )}
        </p>
      ) : null}
    </div>
  )
}
