import { translate } from '@/i18n/i18n'
import type { ComputerAwakeMode } from '../../../../shared/computer-awake-mode'
import { searchKeywords } from './settings-search-keywords'

const AGENT_AWAKE_TITLE_KEY = 'auto.components.settings.agent-awake-copy.modeTitle'
const AGENT_AWAKE_DESCRIPTION_WINDOWS_KEY =
  'auto.components.settings.agent-awake-copy.modeDescriptionWindows'
const AGENT_AWAKE_DESCRIPTION_DEFAULT_KEY =
  'auto.components.settings.agent-awake-copy.modeDescriptionDefault'
const KEEP_DISPLAY_AWAKE_TITLE_KEY =
  'auto.components.settings.agent-awake-copy.keepDisplayAwakeTitle'
const KEEP_DISPLAY_AWAKE_DESCRIPTION_KEY =
  'auto.components.settings.agent-awake-copy.keepDisplayAwakeDescription'

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

export function getKeepDisplayAwakeTitle(): string {
  return translate(KEEP_DISPLAY_AWAKE_TITLE_KEY, 'Keep the display awake')
}

export function getKeepDisplayAwakeDescription(): string {
  return translate(
    KEEP_DISPLAY_AWAKE_DESCRIPTION_KEY,
    'Also blocks display sleep while keeping this Mac awake. Display sleep can trigger the screen lock, which can lock 1Password and similar SSH agents — git pushes from running agents can then fail.'
  )
}

export function getKeepDisplayAwakeSearchKeywords(): string[] {
  return searchKeywords([
    { key: 'auto.components.settings.agents.search.ff8de8a2ad', fallback: 'display' },
    { key: 'auto.components.settings.agents.search.dbc8aca6b0', fallback: 'sleep' },
    { key: 'auto.components.settings.agents.search.ssh', fallback: 'ssh', englishOnly: true },
    {
      key: 'auto.components.settings.agents.search.passwordManager',
      fallback: 'password manager'
    },
    { key: 'auto.components.settings.agents.search.screenLock', fallback: 'screen lock' },
    {
      key: 'auto.components.settings.agents.search.onePassword',
      fallback: '1password',
      englishOnly: true
    }
  ])
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
