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
        'MCP servers from Claude Code and Codex on this computer, synced to your cloud workspaces.'
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
 * JA-16: in Orca Cloud builds every cloud entry sits in one group, led by Agent accounts and the
 * Orca account, instead of being split across AI capabilities, Set up and Orca Cloud.
 */
export function gatherOrcaCloudSettingsGroup(
  sections: readonly SettingsNavSection[],
  { isWebClient, isOrcaCloudApiAvailable }: SettingsNavigationBuildOptions
): SettingsNavSection[] {
  if (isWebClient || !isOrcaCloudApiAvailable) {
    return [...sections]
  }
  const leadIds = ['accounts', 'orca-account']
  const leads = leadIds
    .map((id) => sections.find((section) => section.id === id))
    .filter((section): section is SettingsNavSection => section !== undefined)
    .map((section) => ({ ...section, group: 'orca-cloud' as const }))
  const rest = sections.filter((section) => !leadIds.includes(section.id))
  const firstCloud = rest.findIndex((section) => section.group === 'orca-cloud')
  const at = firstCloud === -1 ? rest.length : firstCloud
  return [...rest.slice(0, at), ...leads, ...rest.slice(at)]
}
