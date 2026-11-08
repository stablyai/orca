import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { ComputerAwakeMode } from '../../../../../../shared/computer-awake-mode'
import { searchKeywords } from '../../search/settings-search-keywords'

const AGENT_AWAKE_TITLE_KEY = 'auto.components.settings.agent-awake-copy.modeTitle'
const AGENT_AWAKE_DESCRIPTION_WINDOWS_KEY =
  'auto.components.settings.agent-awake-copy.modeDescriptionWindows'
const AGENT_AWAKE_DESCRIPTION_MAC_KEY =
  'auto.components.settings.agent-awake-copy.modeDescriptionMac'
const AGENT_AWAKE_DESCRIPTION_DEFAULT_KEY =
  'auto.components.settings.agent-awake-copy.modeDescriptionDefault'

export function getAgentAwakeTitle(t: Translate = translate): string {
  return t(AGENT_AWAKE_TITLE_KEY, 'Keep computer awake')
}

export function getAgentAwakeModeLabel(mode: ComputerAwakeMode, t: Translate = translate): string {
  if (mode === 'on') {
    return t('auto.components.settings.AgentAwakeSetting.on', 'On')
  }
  if (mode === 'auto') {
    return t('auto.components.settings.AgentAwakeSetting.auto', 'Agent')
  }
  return t('auto.components.settings.AgentAwakeSetting.off', 'Off')
}

export function getAgentAwakeDescription(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  t: Translate = translate
): string {
  if (userAgent.includes('Windows')) {
    return t(
      AGENT_AWAKE_DESCRIPTION_WINDOWS_KEY,
      "Choose On, Agent, or Off. Agent mode stays awake while agents are working; lid-close behavior follows this device's power settings."
    )
  }
  // macOS caffeinate can't hold a closed lid awake; Linux blocks logind's lid switch.
  if (userAgent.includes('Mac')) {
    return t(
      AGENT_AWAKE_DESCRIPTION_MAC_KEY,
      'Choose On, Agent, or Off. Agent mode prevents idle sleep while agents work, so long runs finish with the lid open. Closing the lid still puts this Mac to sleep.'
    )
  }

  return t(
    AGENT_AWAKE_DESCRIPTION_DEFAULT_KEY,
    'Choose On, Agent, or Off. Agent mode stays awake while agents are working. Orca also asks this device to stay awake when the lid is closed, subject to its power policy.'
  )
}

export function getAgentAwakeLidNote(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  t: Translate = translate
): string {
  if (userAgent.includes('Windows')) {
    return t(
      'auto.components.settings.agent-awake-copy.lidNoteWindows',
      "Lid-close behavior follows this device's power settings."
    )
  }
  if (userAgent.includes('Mac')) {
    return t(
      'auto.components.settings.agent-awake-copy.lidNoteMac',
      'Prevents idle sleep with the lid open; closing the lid still puts this Mac to sleep.'
    )
  }
  return t(
    'auto.components.settings.agent-awake-copy.lidNoteDefault',
    'Orca also asks this device to stay awake when the lid is closed, subject to its power policy.'
  )
}

export function getAgentAwakeSearchKeywords(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  t?: Translate
): string[] {
  const keywords = searchKeywords(
    [
      { key: 'auto.components.settings.agents.search.66b6b82eb4', fallback: 'awake' },
      { key: 'auto.components.settings.agents.search.dbc8aca6b0', fallback: 'sleep' },
      { key: 'auto.components.settings.agents.search.845ad9128a', fallback: 'power' },
      { key: 'auto.components.settings.agents.search.96ba2373b6', fallback: 'agent' },
      { key: 'auto.components.settings.agents.search.48f84d10f1', fallback: 'running' },
      { key: 'auto.components.settings.agents.search.affbf130f6', fallback: 'working' },
      { key: 'auto.components.settings.agents.search.0d1c334987', fallback: 'lid' },
      { key: 'auto.components.settings.agents.search.ff8de8a2ad', fallback: 'display' }
    ],
    t
  )

  return userAgent.includes('Linux')
    ? [
        ...keywords,
        ...searchKeywords(
          [{ key: 'auto.components.settings.agents.search.f622b8eb2a', fallback: 'linux' }],
          t
        )
      ]
    : keywords
}
