import { translate } from '@/i18n/i18n'
import { searchKeywords } from './settings-search-keywords'

const AGENT_AWAKE_TITLE_KEY = 'auto.components.settings.agent-awake-copy.modeTitle'
const AGENT_AWAKE_DESCRIPTION_WINDOWS_KEY =
  'auto.components.settings.agent-awake-copy.modeDescriptionWindows'
const AGENT_AWAKE_DESCRIPTION_DEFAULT_KEY =
  'auto.components.settings.agent-awake-copy.modeDescriptionDefault'

export function getAgentAwakeTitle(): string {
  return translate(AGENT_AWAKE_TITLE_KEY, 'Keep computer awake')
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
