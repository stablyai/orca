import { translate } from '@/i18n/i18n'
import type {
  AmphetamineUnavailableReason,
  ComputerAwakeMode
} from '../../../../shared/computer-awake-mode'
import { searchKeywords } from './settings-search-keywords'

const AGENT_AWAKE_TITLE_KEY = 'auto.components.settings.agent-awake-copy.modeTitle'
const AGENT_AWAKE_DESCRIPTION_WINDOWS_KEY =
  'auto.components.settings.agent-awake-copy.modeDescriptionWindows'
const AGENT_AWAKE_DESCRIPTION_DEFAULT_KEY =
  'auto.components.settings.agent-awake-copy.modeDescriptionDefault'

export function getAgentAwakeTitle(): string {
  return translate(AGENT_AWAKE_TITLE_KEY, 'Keep computer awake')
}

export function getAgentAwakeModeLabel(mode: ComputerAwakeMode): string {
  if (mode === 'on') {
    return translate('auto.components.settings.AgentAwakeSetting.on', 'On')
  }
  if (mode === 'auto') {
    return translate('auto.components.settings.AgentAwakeSetting.auto', 'Agent')
  }
  return translate('auto.components.settings.AgentAwakeSetting.off', 'Off')
}

export function getAgentAwakeDescription(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
): string {
  if (userAgent.includes('Windows')) {
    return translate(
      AGENT_AWAKE_DESCRIPTION_WINDOWS_KEY,
      "Choose On, Agent, or Off. Agent mode stays awake while agents are working; lid-close behavior follows this device's power settings."
    )
  }

  return translate(
    AGENT_AWAKE_DESCRIPTION_DEFAULT_KEY,
    'Choose On, Agent, or Off. Agent mode stays awake while agents are working. Orca also asks this device to stay awake when the lid is closed, subject to its power policy.'
  )
}

export function getAgentAwakeSearchKeywords(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
): string[] {
  const keywords = searchKeywords([
    { key: 'auto.components.settings.agents.search.66b6b82eb4', fallback: 'awake' },
    { key: 'auto.components.settings.agents.search.dbc8aca6b0', fallback: 'sleep' },
    { key: 'auto.components.settings.agents.search.845ad9128a', fallback: 'power' },
    { key: 'auto.components.settings.agents.search.96ba2373b6', fallback: 'agent' },
    { key: 'auto.components.settings.agents.search.48f84d10f1', fallback: 'running' },
    { key: 'auto.components.settings.agents.search.affbf130f6', fallback: 'working' },
    { key: 'auto.components.settings.agents.search.0d1c334987', fallback: 'lid' },
    { key: 'auto.components.settings.agents.search.ff8de8a2ad', fallback: 'display' }
  ])

  return userAgent.includes('Linux')
    ? [
        ...keywords,
        ...searchKeywords([
          { key: 'auto.components.settings.agents.search.f622b8eb2a', fallback: 'linux' }
        ])
      ]
    : keywords
}

export function getAmphetamineIntegrationTitle(): string {
  return translate(
    'auto.components.settings.AgentAwakeSetting.integrationTitle',
    'Amphetamine integration'
  )
}

export function getAmphetamineIntegrationDescription(
  amphetamineInstalled?: boolean,
  unavailableReason?: AmphetamineUnavailableReason
): string {
  if (amphetamineInstalled === false || unavailableReason === 'not-installed') {
    return translate(
      'auto.components.settings.AgentAwakeSetting.integrationDescriptionMissing',
      'When keep-awake is active, Orca uses Caffeinate. Install Amphetamine to let Orca observe a session you start manually or with a Trigger; Orca never starts or stops it.'
    )
  }
  if (unavailableReason === 'automation-denied') {
    return translate(
      'auto.components.settings.AgentAwakeSetting.integrationDescriptionDenied',
      'When keep-awake is active, Orca uses Caffeinate. Orca only observes Amphetamine session activity. Allow Orca in System Settings › Privacy & Security › Automation, then check again.'
    )
  }
  return translate(
    'auto.components.settings.AgentAwakeSetting.integrationDescription',
    'When keep-awake is active, Orca uses Caffeinate. Optionally observe a session you start manually or with an Amphetamine Trigger; Orca never starts or stops it.'
  )
}

export function getAmphetamineIntegrationSearchKeywords(): string[] {
  return searchKeywords([
    { key: 'auto.components.settings.agents.search.66b6b82eb4', fallback: 'awake' },
    { key: 'auto.components.settings.agents.search.845ad9128a', fallback: 'power' },
    { key: 'auto.components.settings.agents.search.caffeinate', fallback: 'Caffeinate' },
    { key: 'auto.components.settings.agents.search.amphetamine', fallback: 'Amphetamine' },
    { key: 'auto.components.settings.agents.search.macos', fallback: 'macOS' }
  ])
}
