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

// Why: idle keywords used inside `detectAgentStatusFromTitle` to map titles
// like "Codex done", "OpenCode ready", "Aider idle" to AgentStatus 'idle'.
// `as const` so consumers receive literal-union types.
const STRONG_IDLE_KEYWORDS = ['ready', 'idle', 'done'] as const

// Why: working keywords used inside `detectAgentStatusFromTitle` to map
// titles like "Codex working", "Aider thinking", "OpenCode running" to
// AgentStatus 'working'. Shared with `clearWorkingIndicators` so both stay
// in lock-step when stripping working indicators from stale titles.
const STRONG_WORKING_KEYWORDS = ['working', 'thinking', 'running'] as const

// Why: match STRONG_IDLE_KEYWORDS only when not adjacent to characters that
// would make the "keyword" part of a larger token. Plain `\b` alone is
// insufficient because `-` is a non-word character in JS regex, so `\bready\b`
// still matches inside "is-ready-cap" (a `\b` boundary falls between `-` and
// `r`).
//
// Lookarounds are intentionally ASYMMETRIC:
//   - LEFT: reject `[\w./\\-]` so path fragments like `~/codex/ready`,
//     Windows `C:\codex\ready`, and `codex.ready` cannot mint a strong idle
//     signal by having the agent name sit earlier in the same path and the
//     keyword land right after a path separator. Orca is a cross-platform
//     Electron app, so Windows path separators must be handled too.
//   - RIGHT: reject only `[\w\-]` so legitimate sentence-style titles like
//     "Codex done." / "Aider idle." / "OpenCode ready!" still match — path
//     separators after the keyword are not a false-positive vector in
//     practice and blocking them would regress trailing-punctuation titles.
//
// Also rejects hyphenated compounds ("is-ready-cap", "re-done") and plain
// substring false positives ("already"/"redone"/"idleness").
export const STRONG_IDLE_KEYWORDS_RE = new RegExp(
  `(?<![\\w./\\\\-])(${STRONG_IDLE_KEYWORDS.join('|')})(?![\\w\\-])`,
  'i'
)

// Why: mirrors STRONG_IDLE_KEYWORDS_RE — plain substring matching on the
// working keywords caused the symmetric class of false positives, e.g.
// "reworking" ⊃ "working", "overthinking" ⊃ "thinking", "rerunning" ⊃
// "running", hyphenated compounds like "is-thinking-cap", AND cwd-path
// fragments like "~/codex/working" or "C:\codex\working". Uses the same
// asymmetric lookarounds as STRONG_IDLE_KEYWORDS_RE (path separators blocked
// on the left only so "Codex working." still matches). A false 'working'
// classification is worse than the idle one because it drives active-agent
// UI (spinners, counts), so word-char- and left-path-separator-aware
// matching is required here too.
export const STRONG_WORKING_KEYWORDS_RE = new RegExp(
  `(?<![\\w./\\\\-])(${STRONG_WORKING_KEYWORDS.join('|')})(?![\\w\\-])`,
  'i'
)

// Why: global-flag companion of STRONG_WORKING_KEYWORDS_RE used by
// clearWorkingIndicators to strip ALL occurrences in a single pass. Keeps
// clearing and detection in lock-step — both use identical [\w\-] lookarounds,
// so `clearWorkingIndicators` no longer strips keywords out of hyphenated
// compounds like "is-working-cap" that `detectAgentStatusFromTitle` would
// correctly refuse to classify as working.
export const STRONG_WORKING_KEYWORDS_RE_GLOBAL = new RegExp(STRONG_WORKING_KEYWORDS_RE.source, 'gi')

function containsAny(title: string, words: readonly string[]): boolean {
  const lower = title.toLowerCase()
  return words.some((word) => lower.includes(word))
}

/**
 * Tracks agent status transitions from terminal title changes.
 * Fires `onBecameIdle` when an agent transitions from working to idle/permission,
 * like haunt's attention flag — the key trigger for unread notifications.
 */
export function createAgentStatusTracker(
  onBecameIdle: (title: string) => void,
  onBecameWorking?: () => void,
  onAgentExited?: () => void
): {
  handleTitle: (title: string) => void
  /** Clear accumulated status so a stale working→idle transition cannot fire
   *  after the owning transport is torn down. */
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
      // Why: when the title reverts to a plain shell prompt (e.g., "bash", "zsh"),
      // detectAgentStatusFromTitle returns null. If we were idle or in a permission
      // prompt, this means the user exited the agent — clear session-tied state
      // (like the prompt-cache countdown). We intentionally do NOT fire this when
      // lastStatus is 'working', because active agents can briefly flash shell
      // titles during internal operations without actually exiting.
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

// Why: cursor-agent's native OSC title is the literal string "Cursor Agent"
// across the entire turn — it carries zero working/idle information. Orca
// synthesizes its own titles ("⠋ Cursor Agent" for working, "Cursor -
// action required" for permission) from cursor's hook events; the bare
// native title must be a no-op so cursor's per-turn re-emissions cannot
// stomp the synthesized state back to idle.
const CURSOR_NATIVE_TITLE_LOWER = 'cursor agent'

export function detectAgentStatusFromTitle(title: string): AgentStatus | null {
  if (!title) {
    return null
  }
  if (isClaudeManagementTitle(title)) {
    return null
  }
  // Why: "Cursor Agent" exactly (case-insensitive, no prefix/suffix) is cursor's
  // native title. Anything with additional tokens ("⠋ Cursor Agent", "Cursor -
  // action required") is either an Orca-synthesized working/permission title
  // or a tighter match worth classifying.
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

  // Why: resolve synthetic Pi/OMP permission/idle labels before the broader
  // Pi and braille-spinner checks below.
  const piCompatibleSyntheticAgentStatus = getPiCompatibleSyntheticAgentStatus(title)
  if (piCompatibleSyntheticAgentStatus) {
    return piCompatibleSyntheticAgentStatus
  }

  // Claude Code uses ✳ prefix for idle — must check before braille/agent-name
  // because the title text is the task description, not "Claude Code".
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
    // Why: hyphen/word-char-aware boundary match (not plain substring, and
    // stricter than `\b` — which treats `-` as a boundary) so titles like
    // "~/codex already built" do not classify as idle via the substring
    // "already" ⊃ "ready". See STRONG_IDLE_KEYWORDS_RE comment.
    if (STRONG_IDLE_KEYWORDS_RE.test(title)) {
      return 'idle'
    }
    // Why: hyphen/word-char-aware boundary match (not plain substring, and
    // stricter than `\b`) so titles like "~/codex reworking diff" or
    // "is-thinking-cap" do not classify as working via the substrings
    // "reworking" ⊃ "working" or the `-`-adjacent "thinking" in
    // "is-thinking-cap". Mirrors STRONG_IDLE_KEYWORDS_RE for symmetry; a
    // false 'working' is worse than a false 'idle' because it drives
    // active-agent UI (spinners, counts).
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

    // Why: Factory Droid can publish native titles like "Factory Droid needs
    // input" while an Execute tool is still sleeping. Droid's hook events are
    // authoritative; don't turn a name-only native title into a completion.
    if (hasDroidAgentName && !hasLegacyAgentName) {
      return null
    }

    return 'idle'
  }

  return null
}
