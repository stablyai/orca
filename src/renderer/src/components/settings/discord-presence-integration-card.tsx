import { useEffect, useState } from 'react'
import { DiscordIcon } from '@/components/icons/DiscordIcon'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { DiscordPresenceStatus } from '../../../../shared/discord-presence-status'
import { IntegrationCardShell, type IntegrationCardStatusTone } from './integration-card-shell'
import { SettingsSwitch } from './SettingsFormControls'

const DISCORD_PRESENCE_INTEGRATION_SECTION_ID = 'integrations-discord'

function useDiscordPresenceStatus(): DiscordPresenceStatus | null {
  const [status, setStatus] = useState<DiscordPresenceStatus | null>(null)
  useEffect(() => {
    let stale = false
    const unsubscribe = window.api.discordPresence.onChanged((next) => setStatus(next))
    void window.api.discordPresence.getStatus().then((next) => {
      if (!stale) {
        setStatus(next)
      }
    })
    return () => {
      stale = true
      unsubscribe()
    }
  }, [])
  return status
}

function statusPresentation(status: DiscordPresenceStatus | null): {
  label: string
  tone: IntegrationCardStatusTone
} {
  if (status === 'connected') {
    return {
      label: translate('auto.components.settings.discordPresence.statusConnected', 'Connected'),
      tone: 'connected'
    }
  }
  if (status === 'unavailable') {
    return {
      label: translate(
        'auto.components.settings.discordPresence.statusUnavailable',
        'Discord not running'
      ),
      tone: 'attention'
    }
  }
  return {
    label: translate('auto.components.settings.discordPresence.statusOff', 'Off'),
    tone: 'neutral'
  }
}

export function DiscordPresenceIntegrationCard(): React.JSX.Element {
  const enabled = useAppStore((s) => s.settings?.discordPresenceEnabled === true)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const status = useDiscordPresenceStatus()
  const { label, tone } = statusPresentation(status)

  return (
    <IntegrationCardShell
      settingsSectionId={DISCORD_PRESENCE_INTEGRATION_SECTION_ID}
      icon={<DiscordIcon className="size-5" />}
      name="Discord"
      description={translate(
        'auto.components.settings.discordPresence.description',
        'Show how many agents you are running on your Discord profile. Project, branch, and file names are never shared.'
      )}
      checking={status === null || status === 'connecting'}
      statusTone={tone}
      statusLabel={label}
      actions={
        <SettingsSwitch
          checked={enabled}
          onChange={() => void updateSettings({ discordPresenceEnabled: !enabled })}
          ariaLabel={translate(
            'auto.components.settings.discordPresence.toggleLabel',
            'Share activity on Discord'
          )}
        />
      }
    />
  )
}
