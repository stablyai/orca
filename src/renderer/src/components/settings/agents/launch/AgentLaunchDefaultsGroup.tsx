import { useTranslate } from '@/i18n/use-translate'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { AGENT_PERMISSIONS_SECTION_ID } from '../agents-search'

export function AgentLaunchDefaultsGroup({
  description,
  permissions
}: {
  description: string
  permissions: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <SettingsGroup
      title={t('settings.agents.newAgentsTitle', 'New agents')}
      description={description}
    >
      <div id={AGENT_PERMISSIONS_SECTION_ID} data-settings-row="" className="py-3">
        {permissions}
      </div>
    </SettingsGroup>
  )
}
