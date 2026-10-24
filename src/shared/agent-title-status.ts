import { getDeepSeekBuildTitleStatus } from './dsb-terminal-title'
import { qoderTitleStatus } from './qoder-terminal-title'
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
  QUARTER_CIRCLE_SPINNER_RE,
  STRONG_IDLE_KEYWORDS_RE,
  STRONG_WORKING_KEYWORDS_RE,
  STRONG_WORKING_KEYWORDS_RE_GLOBAL,
  containsAgentName,
  containsAgentSpinnerGlyph,
  containsAny,
  containsQuarterCircleSpinner,
  containsLegacyAgentName,
  isClaudeManagementTitle,
  isDshTerminalTitle,
  isGeminiTerminalTitle,
  isPiAgentTitle,
  isPiTerminalTitle
} from './agent-title-core'
import type { AgentStatus } from './agent-title-core'
import { isOpenCodeNativeTitle } from './opencode-terminal-title'
import {
  getPiCompatibleTitleSeparatorStatus,
  getPiCompatibleSyntheticAgentStatus
} from './pi-compatible-synthetic-title'
import { clearPiStateWorkingMarker, getPiStateTitleStatus } from './pi-state-title-marker'
import { getWrapperTitleSegments } from './terminal-title-wrapper-segments'
import { isGrokRotatingWorkingTitle } from './terminal-title-agent-type'
import { memoizeTitleClassification } from './terminal-title-classification-memo'

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

/** Where a working agent settled: at rest, or on a prompt that needs the user. */
export type AgentIdleStatus = Exclude<AgentStatus, 'working'>

/** Explicit OSC 7501 activity outranks glyphs; classify titles only without a program report. */
export function createAgentStatusTracker(
  onBecameIdle: (title: string, status: AgentIdleStatus) => void,
  onBecameWorking?: () => void,
  onAgentExited?: () => void,
  initialTitle?: string
): {
  handleTitle: (title: string) => void
  handleProgramActivity: (activity: AgentStatus | null) => void
  /** Adopt replayed activity without edges, as replayed titles move no status. */
  seedProgramActivity: (activity: AgentStatus | null) => void
  seedTitle: (title: string) => void
  restoreLastExit: (confirmedStatus?: AgentStatus) => AgentStatus | null
  reset: () => void
} {
  // Restore a silent baseline so hidden agents can still emit their later idle transition.
  let lastStatus: AgentStatus | null =
    initialTitle !== undefined ? detectAgentStatusFromTitle(initialTitle) : null
  let restorableExitStatus: AgentStatus | null = null
  let programActivity: AgentStatus | null = null
  let lastTitle = initialTitle ?? ''

  function transition(newStatus: AgentStatus | null, title: string): void {
    if (newStatus !== null) {
      restorableExitStatus = null
    }
    if (lastStatus === 'working' && newStatus !== null && newStatus !== 'working') {
      onBecameIdle(title, newStatus)
    }
    if (lastStatus !== 'working' && newStatus === 'working') {
      onBecameWorking?.()
    }
    // A shell title after idle/permission proves exit; during work it may be transient.
    if (lastStatus !== null && lastStatus !== 'working' && newStatus === null) {
      restorableExitStatus = lastStatus
      lastStatus = null
      onAgentExited?.()
    }
    if (newStatus !== null) {
      lastStatus = newStatus
    }
  }

  return {
    handleTitle(title: string): void {
      lastTitle = title
      transition(programActivity ?? detectAgentStatusFromTitle(title), title)
    },
    handleProgramActivity(activity: AgentStatus | null): void {
      programActivity = activity
      // Why no transition on null: the program stopped reporting, so the next title decides.
      if (activity !== null) {
        transition(activity, lastTitle)
      }
    },
    seedProgramActivity(activity: AgentStatus | null): void {
      programActivity = activity
      // The restored state is the baseline later live edges compare against.
      if (activity !== null) {
        lastStatus = activity
        restorableExitStatus = null
      }
    },
    seedTitle(title: string): void {
      lastTitle = title
      lastStatus = programActivity ?? detectAgentStatusFromTitle(title)
      restorableExitStatus = null
    },
    restoreLastExit(confirmedStatus?: AgentStatus): AgentStatus | null {
      const restoredStatus = confirmedStatus ?? (lastStatus === null ? restorableExitStatus : null)
      if (restoredStatus !== null) {
        lastStatus = restoredStatus
      }
      restorableExitStatus = null
      return restoredStatus
    },
    reset(): void {
      lastStatus = null
      restorableExitStatus = null
      programActivity = null
      lastTitle = ''
    }
  }
}

/**
 * Normalize high-churn agent titles into stable display labels before storage.
 */
export function normalizeTerminalTitle(title: string): string {
  if (getDeepSeekBuildTitleStatus(title)) {
    return title
  }
  const qoderStatus = qoderTitleStatus(title)
  if (qoderStatus) {
    const label = title.includes('Qoder CLI CN') ? 'Qoder CLI CN' : 'Qoder CLI'
    return `${qoderStatus === 'working' ? '✦' : qoderStatus === 'permission' ? '▲' : '◇'} ${label}`
  }
  if (!title) {
    return title
  }

  // Pi/OMP explicit markers outrank Gemini glyphs embedded in free-form session/cwd labels.
  if (!getPiStateTitleStatus(title) && isGeminiTerminalTitle(title)) {
    const status = detectAgentStatusFromTitle(title)
    if (status === 'permission') {
      return `${GEMINI_PERMISSION} Gemini CLI`
    }
    if (status === 'working') {
      return `${GEMINI_WORKING} Gemini CLI`
    }
    // Require a glyph before stamping Gemini rest state; a bare shell auto-title is not readiness evidence.
    if (status === 'idle' && title.includes(GEMINI_IDLE)) {
      return `${GEMINI_IDLE} Gemini CLI`
    }
  }

  // Canonicalize Pi/OMP braille frames in place, including medial frames and multiplexer segments, retaining session/cwd (#16093, #8032).
  if (getWrapperTitleSegments(title).some(isPiAgentTitle)) {
    return canonicalizeBrailleSpinnerFrame(title)
  }

  // Collapse Grok spinner/status churn to one label; idle titles pass through so the final semantic title remains (#7863).
  if (isGrokRotatingWorkingTitle(title)) {
    return '\u280b Grok'
  }

  return title
}

/** Why: any braille frame reads as the same animation step, so consecutive frames dedupe. */
function canonicalizeBrailleSpinnerFrame(title: string): string {
  let canonical = ''
  for (const char of title) {
    const codePoint = char.codePointAt(0)
    canonical +=
      codePoint !== undefined && codePoint >= 0x2800 && codePoint <= 0x28ff ? '\u280b' : char
  }
  return canonical
}

function computeAgentStatusFromTitle(title: string): AgentStatus | null {
  const buildStatus = getDeepSeekBuildTitleStatus(title)
  if (buildStatus) {
    return buildStatus
  }
  const qoderStatus = qoderTitleStatus(title)
  if (qoderStatus) {
    return qoderStatus
  }
  if (!title || isClaudeManagementTitle(title)) {
    return null
  }
  if (title.trim().toLowerCase() === CURSOR_NATIVE_TITLE_LOWER) {
    return null
  }

  if (isOpenCodeNativeTitle(title)) {
    return containsAgentSpinnerGlyph(title) ? 'working' : 'idle'
  }

  // Pi/OMP explicit markers outrank glyphs/keywords embedded in free-form cwd/session labels.
  const piStateStatus = getPiStateTitleStatus(title)
  if (piStateStatus) {
    return piStateStatus
  }

  // DSH uses Gemini's ✦ working glyph at rest; ignore it here. DSH braille covers active spinners and hooks remain authoritative.
  if (!isDshTerminalTitle(title)) {
    if (title.includes(GEMINI_PERMISSION)) {
      return 'permission'
    }
    if (title.includes(GEMINI_WORKING) || title.includes(GEMINI_SILENT_WORKING)) {
      return 'working'
    }
    if (title.includes(GEMINI_IDLE)) {
      return 'idle'
    }
  }

  // Resolve synthetic Pi/OMP idle/permission labels before generic Pi/braille checks.
  const piCompatibleSyntheticAgentStatus = getPiCompatibleSyntheticAgentStatus(title)
  if (piCompatibleSyntheticAgentStatus) {
    return piCompatibleSyntheticAgentStatus
  }

  if (title.startsWith(`${CLAUDE_IDLE} `) || title === CLAUDE_IDLE) {
    return 'idle'
  }
  // Read π ! as blocked before generic idle or OMP user waits disappear.
  const piCompatibleSeparatorStatus = getPiCompatibleTitleSeparatorStatus(title)
  if (piCompatibleSeparatorStatus) {
    return piCompatibleSeparatorStatus
  }
  if (isPiTerminalTitle(title)) {
    return 'idle'
  }
  if (containsAgentSpinnerGlyph(title)) {
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

  // Droid hooks own completion; name-only titles cannot end a still-sleeping execute tool.
  if (hasDroidAgentName && !hasLegacyAgentName) {
    return null
  }

  return 'idle'
}

/** Memoize by unchanged title so sidebar/tab selector reads skip repeated parsing. */
export const detectAgentStatusFromTitle: (title: string) => AgentStatus | null =
  memoizeTitleClassification(computeAgentStatusFromTitle)

/** Quarter-circle-only titles prove activity, not ownership; pane writers need independent evidence (STA-4028, #13925). */
export function isQuarterCircleSpinnerOnlyAgentTitle(title: string | null | undefined): boolean {
  if (!title || !containsQuarterCircleSpinner(title)) {
    return false
  }
  return detectAgentStatusFromTitle(title.replace(QUARTER_CIRCLE_SPINNER_RE, '').trim()) === null
}
