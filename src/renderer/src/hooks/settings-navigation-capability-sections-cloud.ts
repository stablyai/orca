// Orca Cloud additions to the capability and setup Settings nav sections. Each takes the upstream
// list and returns it adjusted, so the upstream builders stay as they are.
import { KeyRound } from 'lucide-react'
import { getAgentApiKeysSearchEntries } from '@/components/settings/agent-api-keys/agent-api-keys-search'
import { getAgentAccountsSearchEntries } from '@/components/settings/agent-accounts/agent-accounts-search'
import type { Translate } from '@/i18n/use-translate'
import type { SettingsNavSection } from '@/components/settings/navigation/settings-navigation-types'
import type { SettingsNavigationBuildOptions } from '../components/settings/navigation/settings-navigation-build-options'

function agentApiKeysSection(
  isOrcaCloudApiAvailable: boolean | undefined,
  t: Translate
): SettingsNavSection {
  return {
    id: 'agent-api-keys',
    title: t('settings.agentApiKeys.title', 'Agent API keys'),
    description: isOrcaCloudApiAvailable
      ? t(
          'settings.agentApiKeys.descriptionCloudSecrets',
          'Keys here work on this computer and your SSH and paired hosts. To use a key in cloud workspaces, save it to your Orca account in Cloud secrets.'
        )
      : t(
          'auto.components.settings.agentApiKeys.description',
          'Optional. Give an agent an API key on every host, or only some, instead of signing in on each machine.'
        ),
    icon: KeyRound,
    searchEntries: getAgentApiKeysSearchEntries(),
    group: 'capabilities',
    badge: t('auto.hooks.useSettingsNavigationMetadata.7c79d3b7bf', 'Optional')
  }
}

export function withOrcaCloudCapabilitySections(
  { isWebClient, isOrcaCloudApiAvailable }: SettingsNavigationBuildOptions,
  t: Translate,
  sections: SettingsNavSection[]
): SettingsNavSection[] {
  const showDesktopOnlySettings = !isWebClient
  return sections.flatMap((section) => {
    if (section.id !== 'accounts') {
      return [section]
    }
    let accounts = section
    // Orca Cloud builds add the Hosts and Orca Cloud parts to this page, so it isn't optional there.
    if (showDesktopOnlySettings && isOrcaCloudApiAvailable) {
      accounts = {
        ...section,
        searchEntries: [...section.searchEntries, ...getAgentAccountsSearchEntries()]
      }
      delete accounts.badge
    }
    // Desktop-owned vault: a web client can neither read nor fill it.
    return showDesktopOnlySettings
      ? [accounts, agentApiKeysSection(isOrcaCloudApiAvailable, t)]
      : [accounts]
  })
}

export function withOrcaCloudSetupSections(
  { isOrcaCloudApiAvailable }: SettingsNavigationBuildOptions,
  t: Translate,
  sections: SettingsNavSection[]
): SettingsNavSection[] {
  if (!isOrcaCloudApiAvailable) {
    return sections
  }
  return sections.map((section) =>
    section.id === 'orca-account'
      ? {
          ...section,
          description: t(
            'settings.orcaAccount.descriptionIdentity',
            'The Orca account you’re signed in with.'
          )
        }
      : section
  )
}
