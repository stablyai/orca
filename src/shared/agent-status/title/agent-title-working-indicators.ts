import {
  BRAILLE_SPINNER_RE,
  GEMINI_WORKING,
  GEMINI_SILENT_WORKING,
  QUARTER_CIRCLE_SPINNER_RE
} from './agent-title-glyphs'
import { containsAgentName, STRONG_WORKING_KEYWORDS_RE_GLOBAL } from './agent-title-core'
import { clearPiStateWorkingMarker } from './providers/pi-state-title-marker'

/**
 * Strip working-status indicators so stale exit titles stop reporting working.
 */
export function clearWorkingIndicators(title: string): string {
  // Strip Pi/OMP's static working marker too or stale titles endlessly re-arm the 3s clear timer (#13890).
  const clearedPiStateMarker = clearPiStateWorkingMarker(title)
  if (clearedPiStateMarker) {
    return clearedPiStateMarker
  }

  let cleaned = title

  cleaned = cleaned.replace(GEMINI_WORKING, '')
  cleaned = cleaned.replace(GEMINI_SILENT_WORKING, '')
  cleaned = cleaned.replace(BRAILLE_SPINNER_RE, '')
  cleaned = cleaned.replace(QUARTER_CIRCLE_SPINNER_RE, '')
  if (cleaned.startsWith('. ')) {
    cleaned = cleaned.slice(2)
  }
  if (containsAgentName(cleaned)) {
    cleaned = cleaned.replace(STRONG_WORKING_KEYWORDS_RE_GLOBAL, '$1')
  }

  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim()
  return cleaned || title
}
