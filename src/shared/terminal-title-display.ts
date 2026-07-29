import {
  AGY_AGENT_NAME_RE,
  DROID_AGENT_NAME_RE,
  HERMES_AGENT_NAME_RE,
  titleHasAnyLegacyAgentName
} from './agent-name-token-match'
import {
  GEMINI_IDLE,
  GEMINI_PERMISSION,
  GEMINI_SILENT_WORKING,
  GEMINI_WORKING,
  isGeminiTerminalTitle,
  isGrokRotatingWorkingTitle,
  isPiAgentTitle
} from './terminal-title-agent-type'
import {
  detectAgentStatusFromTitle,
  STRONG_WORKING_KEYWORDS_RE_GLOBAL
} from './terminal-title-status'

function containsAgentName(title: string): boolean {
  return (
    titleHasAnyLegacyAgentName(title) ||
    AGY_AGENT_NAME_RE.test(title) ||
    DROID_AGENT_NAME_RE.test(title) ||
    HERMES_AGENT_NAME_RE.test(title)
  )
}

/**
 * Strip working-status indicators from a title so that
 * `detectAgentStatusFromTitle` will no longer return 'working'.
 * Used to clear stale titles when an agent exits without resetting its title.
 */
export function clearWorkingIndicators(title: string): string {
  let cleaned = title

  // Gemini working symbols
  cleaned = cleaned.replace(GEMINI_WORKING, '')
  cleaned = cleaned.replace(GEMINI_SILENT_WORKING, '')

  // Braille spinner characters (U+2800–U+28FF)
  // eslint-disable-next-line no-control-regex -- intentional unicode range
  cleaned = cleaned.replace(/[\u2800-\u28FF]/g, '')

  // Claude Code ". " working prefix
  if (cleaned.startsWith('. ')) {
    cleaned = cleaned.slice(2)
  }

  // Strip working keywords that detectAgentStatusFromTitle would pick up
  // when the title also contains an agent name.
  if (containsAgentName(cleaned)) {
    cleaned = cleaned.replace(STRONG_WORKING_KEYWORDS_RE_GLOBAL, '')
  }

  // Collapse whitespace after removals
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim()

  return cleaned || title
}

/**
 * Normalize high-churn agent titles into stable display labels before storing
 * them in app state. Gemini CLI can emit per-keystroke title updates, which
 * otherwise causes broad rerenders and visible flashing.
 */
export function normalizeTerminalTitle(title: string): string {
  if (!title) {
    return title
  }

  if (isGeminiTerminalTitle(title)) {
    const status = detectAgentStatusFromTitle(title)
    if (status === 'permission') {
      return `${GEMINI_PERMISSION} Gemini CLI`
    }
    if (status === 'working') {
      return `${GEMINI_WORKING} Gemini CLI`
    }
    if (status === 'idle') {
      return `${GEMINI_IDLE} Gemini CLI`
    }
  }

  // Why: Pi's titlebar extension animates every 80ms with different braille
  // frames. Collapsing those frames into one stable label avoids renderer
  // churn while preserving the working/idle transition Orca keys off.
  if (isPiAgentTitle(title)) {
    const status = detectAgentStatusFromTitle(title)
    if (status === 'working') {
      return '\u280b Pi'
    }
    if (status === 'idle') {
      return 'Pi'
    }
  }

  // Why: Grok Build interpolates a rotating status/tool phrase between the
  // spinner and its name, so its working frames change the title many times per
  // turn. Collapse them to one stable label; idle/session titles carry no
  // spinner and pass through, so the meaningful final title still shows.
  if (isGrokRotatingWorkingTitle(title)) {
    return '\u280b Grok'
  }

  return title
}
