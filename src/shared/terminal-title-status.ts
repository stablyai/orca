import {
  AGY_AGENT_NAME_RE,
  DROID_AGENT_NAME_RE,
  HERMES_AGENT_NAME_RE,
  titleHasAnyLegacyAgentName
} from './agent-name-token-match'
import { getPiCompatibleSyntheticAgentStatus } from './pi-compatible-synthetic-title'
import {
  CLAUDE_IDLE,
  containsBrailleSpinner,
  GEMINI_IDLE,
  GEMINI_PERMISSION,
  GEMINI_SILENT_WORKING,
  GEMINI_WORKING,
  isClaudeManagementTitle,
  isPiTerminalTitle
} from './terminal-title-agent-type'

export type AgentStatus = 'working' | 'permission' | 'idle'

// Idle-status keywords; `as const` gives consumers literal-union types.
const STRONG_IDLE_KEYWORDS = ['ready', 'idle', 'done'] as const

// Working-status keywords, shared with `clearWorkingIndicators` so detection and stripping stay in lock-step.
const STRONG_WORKING_KEYWORDS = ['working', 'thinking', 'running'] as const

// Why: `\b` fails since "-" is a non-word char (`\bready\b` matches "is-ready-cap"); lookarounds are asymmetric — reject path chars left, allow trailing punctuation ("Codex done.") right.
export const STRONG_IDLE_KEYWORDS_RE = new RegExp(
  `(?<![\\w./\\\\-])(${STRONG_IDLE_KEYWORDS.join('|')})(?![\\w\\-])`,
  'i'
)

// Why: mirrors STRONG_IDLE_KEYWORDS_RE; boundary match avoids "reworking" ⊃ "working"; a false 'working' is worse (drives active-agent UI).
export const STRONG_WORKING_KEYWORDS_RE = new RegExp(
  `(?<![\\w./\\\\-])(${STRONG_WORKING_KEYWORDS.join('|')})(?![\\w\\-])`,
  'i'
)

// Why: global-flag companion for clearWorkingIndicators; shares lookarounds so clearing and detection stay in lock-step.
export const STRONG_WORKING_KEYWORDS_RE_GLOBAL = new RegExp(STRONG_WORKING_KEYWORDS_RE.source, 'gi')

function containsAny(title: string, words: readonly string[]): boolean {
  const lower = title.toLowerCase()
  return words.some((word) => lower.includes(word))
}

/**
 * Tracks agent status transitions from terminal title changes.
 * Fires `onBecameIdle` on working→idle/permission — the trigger for unread notifications.
 */
export function createAgentStatusTracker(
  onBecameIdle: (title: string) => void,
  onBecameWorking?: () => void,
  onAgentExited?: () => void
): {
  handleTitle: (title: string) => void
  /** Clear status so a stale working→idle transition can't fire after teardown. */
  reset: () => void
} {
  let lastStatus: AgentStatus | null = null

  return {
    handleTitle(title: string): void {
      const newStatus = detectAgentStatusFromTitle(title)
      if (lastStatus === 'working' && newStatus !== null && newStatus !== 'working') {
        onBecameIdle(title)
      }
      if (lastStatus !== 'working' && newStatus === 'working') {
        onBecameWorking?.()
      }
      // Why: null title = reverted to a plain shell prompt (agent exited); skip when 'working' since active agents briefly flash shell titles.
      if (lastStatus !== null && lastStatus !== 'working' && newStatus === null) {
        lastStatus = null
        onAgentExited?.()
      }
      if (newStatus !== null) {
        lastStatus = newStatus
      }
    },
    reset(): void {
      lastStatus = null
    }
  }
}

// Why: cursor's native title is constant and carries no working/idle info; keep it a no-op so per-turn re-emissions can't stomp Orca-synthesized state.
const CURSOR_NATIVE_TITLE_LOWER = 'cursor agent'

export function detectAgentStatusFromTitle(title: string): AgentStatus | null {
  if (!title) {
    return null
  }
  if (isClaudeManagementTitle(title)) {
    return null
  }
  // Why: exact "Cursor Agent" is cursor's info-free native title; titles with extra tokens are Orca-synthesized and worth classifying.
  if (title.trim().toLowerCase() === CURSOR_NATIVE_TITLE_LOWER) {
    return null
  }

  // Gemini CLI symbols are the most specific and should take precedence.
  if (title.includes(GEMINI_PERMISSION)) {
    return 'permission'
  }
  if (title.includes(GEMINI_WORKING) || title.includes(GEMINI_SILENT_WORKING)) {
    return 'working'
  }
  if (title.includes(GEMINI_IDLE)) {
    return 'idle'
  }

  // Why: resolve synthetic Pi/OMP labels before the broader Pi/braille checks below.
  const piCompatibleSyntheticAgentStatus = getPiCompatibleSyntheticAgentStatus(title)
  if (piCompatibleSyntheticAgentStatus) {
    return piCompatibleSyntheticAgentStatus
  }

  // Claude Code uses ✳ idle prefix; check before braille/agent-name since the title is the task description, not "Claude Code".
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
  const hasLegacyAgentName = titleHasAnyLegacyAgentName(title)
  if (hasLegacyAgentName || hasDroidAgentName || hasHermesAgentName || hasAgyAgentName) {
    if (containsAny(title, ['action required', 'permission', 'waiting'])) {
      return 'permission'
    }
    // Why: boundary match (not substring) so "already" ⊃ "ready" isn't classified idle. See STRONG_IDLE_KEYWORDS_RE.
    if (STRONG_IDLE_KEYWORDS_RE.test(title)) {
      return 'idle'
    }
    // Why: false 'working' is worse than false 'idle' (drives active-agent UI); boundary match avoids "reworking" ⊃ "working".
    if (STRONG_WORKING_KEYWORDS_RE.test(title)) {
      return 'working'
    }

    // Claude Code title prefixes: ". " = working, "* " = idle
    if (title.startsWith('. ')) {
      return 'working'
    }
    if (title.startsWith('* ')) {
      return 'idle'
    }

    // Why: Droid's hook events are authoritative; don't treat a name-only native title as a completion.
    if (hasDroidAgentName && !hasLegacyAgentName) {
      return null
    }

    return 'idle'
  }

  return null
}
