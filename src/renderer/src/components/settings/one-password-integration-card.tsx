import { KeyRound } from 'lucide-react'
import { IntegrationCardShell } from './integration-card-shell'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'

export const ONE_PASSWORD_INTEGRATION_SECTION_ID = 'integration-1password'

export function OnePasswordIntegrationCard(): React.JSX.Element {
  const enabled = useAppStore((s) => s.settings?.onePasswordSecretsEnabled ?? false)
  const updateSettings = useAppStore((s) => s.updateSettings)

  return (
    <IntegrationCardShell
      settingsSectionId={ONE_PASSWORD_INTEGRATION_SECTION_ID}
      icon={<KeyRound className="size-5" />}
      name="1Password"
      description={translate(
        'auto.components.settings.one.password.integration.card.description',
        'Resolve op:// secret references in tab environment variables through the 1Password CLI (op) at launch. Requires the op CLI and its desktop-app integration.'
      )}
      statusTone={enabled ? 'connected' : 'neutral'}
      statusLabel={
        enabled
          ? translate('auto.components.settings.one.password.integration.card.statusOn', 'Enabled')
          : translate(
              'auto.components.settings.one.password.integration.card.statusOff',
              'Disabled'
            )
      }
      actions={
        <button
          role="switch"
          aria-checked={enabled}
          aria-label={translate(
            'auto.components.settings.one.password.integration.card.toggleLabel',
            'Enable 1Password secret resolution'
          )}
          onClick={() => updateSettings({ onePasswordSecretsEnabled: !enabled })}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
            enabled ? 'bg-foreground' : 'bg-muted-foreground/30'
          }`}
        >
          <span
            className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
              enabled ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      }
    />
  )
}
