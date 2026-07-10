import { translate } from '@/i18n/i18n'
import { searchKeywords } from './settings-search-keywords'

const AUTO_RESUME_TITLE_KEY = 'auto.components.settings.auto-resume-copy.title'
const AUTO_RESUME_DESCRIPTION_KEY = 'auto.components.settings.auto-resume-copy.description'

export function getAutoResumeTitle(): string {
  return translate(AUTO_RESUME_TITLE_KEY, 'Auto-resume rate-limited agents')
}

export function getAutoResumeDescription(): string {
  return translate(
    AUTO_RESUME_DESCRIPTION_KEY,
    'When an agent hits a provider usage limit, Orca waits for the limit to reset and resumes it automatically.'
  )
}

export function getAutoResumeSearchKeywords(): string[] {
  return searchKeywords([
    { key: 'auto.components.settings.agents.search.autoresume.0', fallback: 'auto-resume' },
    { key: 'auto.components.settings.agents.search.autoresume.1', fallback: 'rate limit' },
    { key: 'auto.components.settings.agents.search.autoresume.2', fallback: 'usage limit' },
    { key: 'auto.components.settings.agents.search.autoresume.3', fallback: 'resume' },
    { key: 'auto.components.settings.agents.search.autoresume.4', fallback: 'paused' },
    { key: 'auto.components.settings.agents.search.autoresume.5', fallback: 'agent' }
  ])
}
