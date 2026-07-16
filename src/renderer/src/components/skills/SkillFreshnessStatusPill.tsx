import { useSkillFreshness } from '@/hooks/useSkillFreshness'
import { translate } from '@/i18n/i18n'
import { IntegrationStatusPill } from '@/components/integration-status-pill'

// Why: the setup rails' Installed pill is presence-only; when freshness knows a
// safe update exists (or that every copy is current) the pill should say so.
// Falls back to plain Installed for blocked/unrecognized copies so an unsafe
// placement is never advertised as updatable here.
export function SkillFreshnessStatusPill({ skillName }: { skillName: string }): React.JSX.Element {
  const { inventory } = useSkillFreshness()
  if (inventory?.eligibleUpdateNames.includes(skillName)) {
    return (
      <IntegrationStatusPill tone="attention">
        {translate(
          'auto.components.skills.SkillFreshnessStatusPill.updateAvailable',
          'Update available'
        )}
      </IntegrationStatusPill>
    )
  }
  const placements = inventory?.installations.filter(
    (installation) => installation.name === skillName
  )
  if (
    placements &&
    placements.length > 0 &&
    placements.every((installation) => installation.status === 'current')
  ) {
    return (
      <IntegrationStatusPill tone="connected">
        {translate('auto.components.skills.SkillFreshnessStatusPill.upToDate', 'Up to date')}
      </IntegrationStatusPill>
    )
  }
  return (
    <IntegrationStatusPill tone="connected">
      {translate('auto.components.skills.SkillFreshnessStatusPill.installed', 'Installed')}
    </IntegrationStatusPill>
  )
}
