import {
  getCloudApiKeysSearchEntries,
  getCloudRoutinesSearchEntries
} from '@/components/settings/cloud-api/cloud-api-search'
import {
  getOrcaCloudBillingSearchEntries,
  getOrcaCloudEnvironmentsSearchEntries,
  getOrcaCloudMcpSearchEntries,
  getOrcaCloudSecretsSearchEntries,
  getOrcaCloudTeamSearchEntries
} from '@/components/settings/orca-cloud/orca-cloud-settings-search'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { SettingsNavSection } from '@/lib/settings-navigation-types'
import { Boxes, CreditCard, KeySquare, LockKeyhole, Plug, Users, Workflow } from 'lucide-react'
import type { SettingsNavigationBuildOptions } from './settings-navigation-build-options'
import { CLOUD_ROUTINES_UI_ENABLED } from '../../../shared/cloud-api/cloud-routines-ui'

/** One home for everything Orca Cloud; only builds with a control plane show it. */
export function buildOrcaCloudSettingsSections(
  { isWebClient, isOrcaCloudApiAvailable }: SettingsNavigationBuildOptions,
  t: Translate = translate
): SettingsNavSection[] {
  if (isWebClient || !isOrcaCloudApiAvailable) {
    return []
  }
  const group = 'orca-cloud'
  return [
    {
      id: 'cloud-billing',
      title: t('auto.components.billing.title', 'Plan & billing'),
      description: t(
        'settings.orcaCloud.billing.description',
        'Your Orca Cloud plan, sandbox hours and payment.'
      ),
      icon: CreditCard,
      searchEntries: getOrcaCloudBillingSearchEntries(),
      group
    },
    {
      id: 'cloud-team',
      title: t('auto.components.billing.team.title', 'Team'),
      description: t(
        'auto.components.billing.team.createHint',
        'Share one Orca Cloud plan with your teammates.'
      ),
      icon: Users,
      searchEntries: getOrcaCloudTeamSearchEntries(),
      group
    },
    {
      id: 'cloud-secrets',
      title: t('cloudSecrets.title', 'Cloud secrets'),
      description: t(
        'cloudSecrets.description',
        'API keys you add to Orca are never written to the sandbox. Agents and terminals get them as environment variables.'
      ),
      icon: LockKeyhole,
      searchEntries: getOrcaCloudSecretsSearchEntries(),
      group
    },
    {
      id: 'cloud-environments',
      title: t('settings.orcaCloud.environments.title', 'Cloud environments'),
      description: t(
        'cloudEnvironment.descriptionTeam',
        'Your team’s repos and install script, built once into a snapshot so every cloud workspace starts with dependencies installed.'
      ),
      icon: Boxes,
      searchEntries: getOrcaCloudEnvironmentsSearchEntries(),
      group
    },
    {
      id: 'cloud-mcp',
      title: t('cloudMcpSync.title', 'MCP servers'),
      description: t(
        'settings.orcaCloud.mcp.description',
        'MCP servers from Claude and Codex on this computer, synced to your cloud workspaces.'
      ),
      icon: Plug,
      searchEntries: getOrcaCloudMcpSearchEntries(),
      group
    },
    {
      id: 'cloud-api-keys',
      title: t('auto.components.settings.cloudApi.sectionTitle', 'Orca API keys'),
      description: t(
        'auto.components.settings.cloudApi.sectionDescription',
        'For the Orca Cloud API, the orca CLI and MCP clients. Claude or Codex keys go in Cloud secrets.'
      ),
      icon: KeySquare,
      searchEntries: getCloudApiKeysSearchEntries(),
      group
    },
    // Parked until Routines join Automations (one flag, cloud-routines-ui.ts).
    ...cloudRoutinesSection(t, group)
  ]
}

function cloudRoutinesSection(t: Translate, group: string): SettingsNavSection[] {
  if (!CLOUD_ROUTINES_UI_ENABLED) {
    return []
  }
  return [
    {
      id: 'cloud-routines',
      title: t('auto.components.settings.cloudRoutines.sectionTitle', 'Routines'),
      description: t(
        'auto.components.settings.cloudRoutines.sectionDescription',
        'Agents that run in Orca Cloud on a schedule, on GitHub events or from a webhook.'
      ),
      icon: Workflow,
      searchEntries: getCloudRoutinesSearchEntries(),
      group
    }
  ]
}

/**
 * JA-16: in Orca Cloud builds the Orca account leads the one Orca Cloud group instead of sitting in
 * Set up. Agent accounts stays in AI capabilities: it covers this computer and hosts as much as
 * Orca Cloud, and its Orca Cloud part is deep-linked from every cloud entry point.
 */
export function gatherOrcaCloudSettingsGroup(
  sections: readonly SettingsNavSection[],
  { isWebClient, isOrcaCloudApiAvailable }: SettingsNavigationBuildOptions
): SettingsNavSection[] {
  if (isWebClient || !isOrcaCloudApiAvailable) {
    return [...sections]
  }
  const leadIds = ['orca-account']
  const leads = leadIds
    .map((id) => sections.find((section) => section.id === id))
    .filter((section): section is SettingsNavSection => section !== undefined)
    .map((section) => ({ ...section, group: 'orca-cloud' as const }))
  const rest = sections.filter((section) => !leadIds.includes(section.id))
  const firstCloud = rest.findIndex((section) => section.group === 'orca-cloud')
  const at = firstCloud === -1 ? rest.length : firstCloud
  return [...rest.slice(0, at), ...leads, ...rest.slice(at)]
}
