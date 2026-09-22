import { LinearIcon } from '@/components/icons/LinearIcon'
import { getAccountsPaneSearchEntries } from '@/components/settings/accounts-search'
import { getAgentsPaneSearchEntries } from '@/components/settings/agents-search'
import { getComputerUsePaneSearchEntries } from '@/components/settings/computer-use-search'
import { getGeneralPaneSearchEntries } from '@/components/settings/general-search'
import { getIntegrationsPaneSearchEntries } from '@/components/settings/integrations-search'
import { getLinearAgentSkillPaneSearchEntries } from '@/components/settings/linear-agent-skill-search'
import { getMobileSettingsPaneSearchEntries } from '@/components/settings/mobile-settings-search'
import { getOrcaAccountSettingsSearchEntries } from '@/components/settings/orca-account-settings-search'
import { OrcaLogoSettingsIcon } from '@/components/settings/orca-logo-settings-icon'
import { getOrchestrationPaneSearchEntries } from '@/components/settings/orchestration-search'
import { getVoicePaneSearchEntries } from '@/components/settings/voice-pane-search'
import { translate } from '@/i18n/i18n'
import type { SettingsNavSection } from '@/lib/settings-navigation-types'
import {
  Blocks,
  Bot,
  CircleUserRound,
  Mic,
  MousePointerClick,
  Network,
  SlidersHorizontal,
  Smartphone,
  UserCog
} from 'lucide-react'
import type { SettingsNavigationBuildOptions } from './settings-navigation-build-options'

export function buildCapabilitySettingsSections({
  isLocalWindowsHost,
  isWebClient,
  isLinearConnected
}: SettingsNavigationBuildOptions): SettingsNavSection[] {
  const showDesktopOnlySettings = !isWebClient
  return [
    {
      id: 'agents',
      title: translate('auto.hooks.useSettingsNavigationMetadata.b49abbd2f7', 'Agents'),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.4121f7a0a2',
        'Manage AI agents, set a default, and customize commands.'
      ),
      icon: Bot,
      searchEntries: getAgentsPaneSearchEntries({
        includeAgentAwake: !isWebClient,
        includeAgentRuntime: isLocalWindowsHost
      }),
      group: 'capabilities'
    },
    {
      id: 'accounts',
      title: translate(
        'auto.hooks.useSettingsNavigationMetadata.f70ac54d38',
        'AI Provider Accounts'
      ),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.b1c2f8b0ac',
        'Optional account switching and usage setup for Claude, Codex, Gemini, OpenCode Go, MiniMax, and Grok.'
      ),
      icon: UserCog,
      searchEntries: getAccountsPaneSearchEntries(),
      group: 'capabilities',
      badge: translate('auto.hooks.useSettingsNavigationMetadata.7c79d3b7bf', 'Optional')
    },
    {
      id: 'orchestration',
      title: translate('auto.hooks.useSettingsNavigationMetadata.58a868e8e4', 'Orchestration'),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.cd50cec5d7',
        'Coordinate multiple coding agents through Orca.'
      ),
      icon: Network,
      searchEntries: getOrchestrationPaneSearchEntries({
        includeNestedWorkerDepth: !isWebClient
      }),
      group: 'capabilities'
    },
    // Why: only surfaced once Linear is connected — a capability that needs a
    // linked provider before the agent skill has anything to act on.
    ...(isLinearConnected
      ? [
          {
            id: 'linear',
            title: translate('auto.hooks.useSettingsNavigationMetadata.linearTitle', 'Linear'),
            description: translate(
              'auto.hooks.useSettingsNavigationMetadata.linearDescription',
              'How Linear works in Orca, setup checklist, agent skill, and example prompts.'
            ),
            icon: LinearIcon,
            searchEntries: getLinearAgentSkillPaneSearchEntries(),
            group: 'capabilities'
          }
        ]
      : []),
    ...(showDesktopOnlySettings
      ? [
          {
            id: 'computer-use',
            title: translate('auto.hooks.useSettingsNavigationMetadata.b35e92364b', 'Computer Use'),
            description: translate(
              'auto.hooks.useSettingsNavigationMetadata.0059bd17f3',
              'Enable agents to control any app on your computer.'
            ),
            icon: MousePointerClick,
            searchEntries: getComputerUsePaneSearchEntries(),
            group: 'capabilities'
          },
          {
            id: 'voice',
            title: translate('auto.hooks.useSettingsNavigationMetadata.6a50cdcd7c', 'Voice'),
            description: translate(
              'auto.hooks.useSettingsNavigationMetadata.8ac3de82f5',
              'Local speech-to-text dictation with on-device models.'
            ),
            icon: Mic,
            searchEntries: getVoicePaneSearchEntries(),
            group: 'capabilities'
          }
        ]
      : [])
  ]
}

export function buildSetupSettingsSections({
  isLocalWindowsHost,
  isWebClient
}: SettingsNavigationBuildOptions): SettingsNavSection[] {
  const showDesktopOnlySettings = !isWebClient
  return [
    ...(showDesktopOnlySettings
      ? [
          {
            id: 'orca-account',
            title: translate('auto.components.settings.orcaAccount.title', 'Orca Account'),
            description: translate(
              'auto.components.settings.orcaAccount.description',
              'Share work instantly and reach your desktop from Orca Mobile wherever you are.'
            ),
            icon: CircleUserRound,
            searchEntries: getOrcaAccountSettingsSearchEntries(),
            group: 'setup'
          }
        ]
      : []),
    {
      id: 'setup-guide',
      title: translate(
        'auto.hooks.useSettingsNavigationMetadata.ded9e9032f',
        'Onboarding checklist'
      ),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.5f32ac08f3',
        'Finish the onboarding checklist for core Orca workflows.'
      ),
      icon: OrcaLogoSettingsIcon,
      searchEntries: [
        {
          title: translate(
            'auto.hooks.useSettingsNavigationMetadata.ded9e9032f',
            'Onboarding checklist'
          ),
          description: translate(
            'auto.hooks.useSettingsNavigationMetadata.17005c73d4',
            'Open the onboarding checklist for setup and milestone steps.'
          ),
          keywords: [
            translate('auto.hooks.useSettingsNavigationMetadata.ea0b1bc7b8', 'setup guide'),
            translate(
              'auto.hooks.useSettingsNavigationMetadata.0505d0df29',
              'get started with Orca'
            ),
            translate('auto.hooks.useSettingsNavigationMetadata.724c440e72', 'getting started')
          ]
        }
      ],
      group: 'setup'
    },
    {
      id: 'general',
      title: translate('auto.hooks.useSettingsNavigationMetadata.13241992bd', 'General'),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.2cd4ea75da',
        'Workspace defaults, app setup, and maintenance.'
      ),
      icon: SlidersHorizontal,
      searchEntries: getGeneralPaneSearchEntries({ includeProjectRuntime: isLocalWindowsHost }),
      group: 'setup'
    },
    {
      id: 'integrations',
      title: translate('auto.hooks.useSettingsNavigationMetadata.2b043783ef', 'Integrations'),
      description: translate(
        'auto.hooks.useSettingsNavigationMetadata.33a5e1d597',
        'Connect GitHub, GitLab, Linear, and source-hosting services.'
      ),
      icon: Blocks,
      searchEntries: getIntegrationsPaneSearchEntries(),
      group: 'setup'
    },
    ...(showDesktopOnlySettings
      ? [
          {
            id: 'mobile',
            title: translate('auto.hooks.useSettingsNavigationMetadata.1cd25673df', 'Mobile'),
            description: translate(
              'auto.hooks.useSettingsNavigationMetadata.95a1886d94',
              'Control terminals and agents from your phone.'
            ),
            icon: Smartphone,
            searchEntries: getMobileSettingsPaneSearchEntries(),
            group: 'setup'
          }
        ]
      : [])
  ]
}
