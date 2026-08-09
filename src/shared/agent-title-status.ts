import {
  AGY_AGENT_NAME_RE,
  BRAILLE_SPINNER_RE,
  CLAUDE_IDLE,
  CURSOR_NATIVE_TITLE_LOWER,
  DROID_AGENT_NAME_RE,
  GEMINI_IDLE,
  GEMINI_PERMISSION,
  GEMINI_SILENT_WORKING,
  GEMINI_WORKING,
  HERMES_AGENT_NAME_RE,
  STRONG_IDLE_KEYWORDS_RE,
  STRONG_WORKING_KEYWORDS_RE,
  STRONG_WORKING_KEYWORDS_RE_GLOBAL,
  containsAgentName,
  containsAny,
  containsBrailleSpinner,
  containsLegacyAgentName,
  isClaudeManagementTitle,
  isGeminiTerminalTitle,
  isQoderCliTerminalTitle,
  QODERCLI_LABEL,
  QODERCLI_PERMISSION,
  isPiAgentTitle,
  isPiTerminalTitle
} from './agent-title-core'
import type { AgentStatus } from './agent-title-core'
import { getPiCompatibleSyntheticAgentStatus } from './pi-compatible-synthetic-title'
import { isGrokRotatingWorkingTitle } from './terminal-title-agent-type'

/**
 * Strip working-status indicators so stale exit titles stop reporting working.
 */
export function clearWorkingIndicators(title: string): string {
  let cleaned = title

  cleaned = cleaned.replace(GEMINI_WORKING, '')
  cleaned = cleaned.replace(GEMINI_SILENT_WORKING, '')
  cleaned = cleaned.replace(BRAILLE_SPINNER_RE, '')
  if (cleaned.startsWith('. ')) {
    cleaned = cleaned.slice(2)
  }
  if (containsAgentName(cleaned)) {
    cleaned = cleaned.replace(STRONG_WORKING_KEYWORDS_RE_GLOBAL, '')
  }

  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim()
  return cleaned || title
}

/**
 * Tracks agent status transitions from terminal title changes.
 */
export function createAgentStatusTracker(
  onBecameIdle: (title: string) => void,
  onBecameWorking?: () => void,
  onAgentExited?: () => void,
  initialTitle?: string
): {
  handleTitle: (title: string) => void
  seedTitle: (title: string) => void
  restoreLastExit: () => AgentStatus | null
  reset: () => void
} {
  // Why: trackers restored mid-session need a last-known status without firing
  // callbacks, or a hidden working agent can miss its later idle transition.
  let lastStatus: AgentStatus | null =
    initialTitle !== undefined ? detectAgentStatusFromTitle(initialTitle) : null
  let restorableExitStatus: AgentStatus | null = null

  return {
    handleTitle(title: string): void {
      const newStatus = detectAgentStatusFromTitle(title)
      if (newStatus !== null) {
        restorableExitStatus = null
      }
      if (lastStatus === 'working' && newStatus !== null && newStatus !== 'working') {
        onBecameIdle(title)
      }
      if (lastStatus !== 'working' && newStatus === 'working') {
        onBecameWorking?.()
      }
      // Why: reverting to a plain shell prompt after idle/permission means the
      // agent exited; while working it can just be a transient internal title.
      if (lastStatus !== null && lastStatus !== 'working' && newStatus === null) {
        restorableExitStatus = lastStatus
        lastStatus = null
        onAgentExited?.()
      }
      if (newStatus !== null) {
        lastStatus = newStatus
      }
    },
    seedTitle(title: string): void {
      lastStatus = detectAgentStatusFromTitle(title)
      restorableExitStatus = null
    },
    restoreLastExit(): AgentStatus | null {
      const restoredStatus = lastStatus === null ? restorableExitStatus : null
      if (restoredStatus !== null) {
        lastStatus = restoredStatus
      }
      restorableExitStatus = null
      return restoredStatus
    },
    reset(): void {
      lastStatus = null
      restorableExitStatus = null
    }
  }
}

/**
 * Normalize high-churn agent titles into stable display labels before storage.
 */
export function normalizeTerminalTitle(title: string): string {
  if (!title) {
    return title
  }

  // Why: qodercli repaints its 80-char padded title on every stream tick, so collapse it the same
  // way Gemini/Pi/Grok frames are collapsed — otherwise the tab label is a space-padded task
  // string. Must precede the Gemini branch. isQoderCliTerminalTitle also matches the collapsed
  // label so re-normalization is idempotent and the next read doesn't fall back to Gemini.
  if (isQoderCliTerminalTitle(title)) {
    const status = detectAgentStatusFromTitle(title)
    if (status === 'permission') {
      return `${QODERCLI_PERMISSION} ${QODERCLI_LABEL}`
    }
    if (status === 'working') {
      return `${GEMINI_WORKING} ${QODERCLI_LABEL}`
    }
    if (status === 'idle') {
      return `${GEMINI_IDLE} ${QODERCLI_LABEL}`
    }
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

  // Why: Pi animates every 80ms; collapse frames while preserving status.
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
  // spinner and pass through, so the meaningful final title still shows (#7863).
  if (isGrokRotatingWorkingTitle(title)) {
    return '\u280b Grok'
  }

  return title
}

export function detectAgentStatusFromTitle(title: string): AgentStatus | null {
  if (!title || isClaudeManagementTitle(title)) {
    return null
  }
  if (title.trim().toLowerCase() === CURSOR_NATIVE_TITLE_LOWER) {
    return null
  }

  // Why: qodercli replaced Gemini's ✋ with ▲ for awaiting-confirmation. Without this its
  // permission state falls through the name-token checks below and yields no status at all.
  // Why anchored, unlike the inherited ✋/✦/◇ checks below: ▲ is ordinary text (deploy output,
  // charts, log markers), so an unanchored `includes` would turn any title merely containing it
  // into a spurious attention badge. qodercli only ever emits it as the leading status glyph.
  if (title.trimStart().startsWith(`${QODERCLI_PERMISSION} `)) {
    return 'permission'
  }
  if (title.includes(GEMINI_PERMISSION)) {
    return 'permission'
  }
  if (title.includes(GEMINI_WORKING) || title.includes(GEMINI_SILENT_WORKING)) {
    return 'working'
  }
  if (title.includes(GEMINI_IDLE)) {
    return 'idle'
  }

  // Why: resolve synthetic Pi/OMP permission/idle labels before the broader
  // Pi and braille-spinner checks below.
  const piCompatibleSyntheticAgentStatus = getPiCompatibleSyntheticAgentStatus(title)
  if (piCompatibleSyntheticAgentStatus) {
    return piCompatibleSyntheticAgentStatus
  }

  if (title.startsWith(`${CLAUDE_IDLE} `) || title === CLAUDE_IDLE) {
    return 'idle'
  }
  if (isPiTerminalTitle(title)) {
    return 'idle'
  }
  if (containsBrailleSpinner(title)) {
    return 'working'
  }

  const hasDroidAgentName = DROID_AGENT_NAME_RE.test(title)
  const hasHermesAgentName = HERMES_AGENT_NAME_RE.test(title)
  const hasAgyAgentName = AGY_AGENT_NAME_RE.test(title)
  const hasLegacyAgentName = containsLegacyAgentName(title)
  if (!hasLegacyAgentName && !hasDroidAgentName && !hasHermesAgentName && !hasAgyAgentName) {
    return null
  }
  if (containsAny(title, ['action required', 'permission', 'waiting'])) {
    return 'permission'
  }
  // Why: boundary-aware regexes avoid cwd/path and substring false positives.
  if (STRONG_IDLE_KEYWORDS_RE.test(title)) {
    return 'idle'
  }
  if (STRONG_WORKING_KEYWORDS_RE.test(title)) {
    return 'working'
  }
  if (title.startsWith('. ')) {
    return 'working'
  }
  if (title.startsWith('* ')) {
    return 'idle'
  }

  // Why: Droid hook events are authoritative; native name-only titles should
  // not turn a still-sleeping execute tool into completion.
  if (hasDroidAgentName && !hasLegacyAgentName) {
    return null
  }

  return 'idle'
}
