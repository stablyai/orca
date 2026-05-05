/**
 * Shared agent detection utilities — used by both the main process (stats
 * collection) and the renderer (activity indicators, unread badges).
 *
 * Why shared: the main process needs the same OSC title extraction and agent
 * status detection for stat tracking that the renderer uses for UI indicators.
 * Duplicating this logic would risk drift between the two detection paths.
 */

export type AgentStatus = 'working' | 'permission' | 'idle'

const CLAUDE_IDLE = '\u2733' // ✳ (eight-spoked asterisk — Claude Code idle prefix)

const GEMINI_WORKING = '\u2726' // ✦
const GEMINI_SILENT_WORKING = '\u23F2' // ⏲
const GEMINI_IDLE = '\u25C7' // ◇
const GEMINI_PERMISSION = '\u270B' // ✋

// Why: this list is for OSC-title detection only. It is intentionally narrower
// than the full set of launchable agents because short names like "amp" are
// unsafe under the substring-based detector and would classify ordinary shell
// titles like "timestamp ready" as agent activity. Product telemetry uses the
// explicit launch/session facts Orca owns, not this inference path.
export const AGENT_NAMES = ['claude', 'codex', 'copilot', 'cursor', 'gemini', 'opencode', 'aider']

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
const STRONG_WORKING_KEYWORDS_RE_GLOBAL = new RegExp(STRONG_WORKING_KEYWORDS_RE.source, 'gi')
const PI_IDLE_PREFIX = '\u03c0 - ' // π - (Pi titlebar extension idle format)

// eslint-disable-next-line no-control-regex -- intentional terminal escape sequence matching
const OSC_TITLE_RE = /\x1b\]([012]);([^\x07\x1b]*?)(?:\x07|\x1b\\)/g

/**
 * Extract the last OSC title-set sequence from raw PTY data.
 * Agent CLIs (Claude Code, Gemini, etc.) set OSC titles to announce their
 * identity and status. This is a single regex scan — comparable cost to one
 * normalizeTerminalChunk pass.
 */
export function extractLastOscTitle(data: string): string | null {
  let last: string | null = null
  for (const m of data.matchAll(OSC_TITLE_RE)) {
    last = m[2]
  }
  return last
}

/**
 * Extract ALL OSC title-set sequences from raw PTY data, in order of appearance.
 * Why separate from extractLastOscTitle: node-pty and the main-process batch
 * window (PTY_BATCH_INTERVAL_MS) often coalesce multiple title changes into
 * one IPC payload. For fast agents (Pi's 80ms spinner + agent_end idle in the
 * same batch), returning only the last title silently drops the working
 * transition. Callers that care about driving UI state transitions
 * (working/idle spinner) need every title in the chunk. See issue #1083's
 * spinner-miss follow-up.
 */
export function extractAllOscTitles(data: string): string[] {
  const titles: string[] = []
  for (const m of data.matchAll(OSC_TITLE_RE)) {
    titles.push(m[2])
  }
  return titles
}

export function isGeminiTerminalTitle(title: string): boolean {
  return (
    title.includes(GEMINI_PERMISSION) ||
    title.includes(GEMINI_WORKING) ||
    title.includes(GEMINI_SILENT_WORKING) ||
    title.includes(GEMINI_IDLE) ||
    title.toLowerCase().includes('gemini')
  )
}

export function isPiTerminalTitle(title: string): boolean {
  return title.startsWith(PI_IDLE_PREFIX)
}

function isPiAgentTitle(title: string): boolean {
  return (
    isPiTerminalTitle(title) || (containsBrailleSpinner(title) && title.includes(PI_IDLE_PREFIX))
  )
}

function containsBrailleSpinner(title: string): boolean {
  for (const char of title) {
    const codePoint = char.codePointAt(0)
    if (codePoint !== undefined && codePoint >= 0x2800 && codePoint <= 0x28ff) {
      return true
    }
  }
  return false
}

function containsAgentName(title: string): boolean {
  const lower = title.toLowerCase()
  return AGENT_NAMES.some((name) => lower.includes(name))
}

function containsAny(title: string, words: readonly string[]): boolean {
  const lower = title.toLowerCase()
  return words.some((word) => lower.includes(word))
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

  return title
}

/**
 * Returns true when the terminal title matches Claude Code's title conventions.
 * Used to scope prompt-cache-timer behavior to Claude sessions only — other
 * agents have different (or no) caching semantics.
 */
export function isClaudeAgent(title: string): boolean {
  if (!title) {
    return false
  }

  // Why: Claude Code titles are prefixed with status indicators (✳, ". ", "* ",
  // braille spinners) followed by the task description. The task text can
  // legitimately mention other agents, so Claude-specific prefixes must win.
  if (title.startsWith(`${CLAUDE_IDLE} `) || title === CLAUDE_IDLE) {
    return true
  }
  // Why: ". " (working) and "* " (idle) are Claude Code title conventions.
  // Other supported agents do not use them, and rejecting titles that mention
  // another agent in the task text caused false negatives for real Claude tabs.
  if (title.startsWith('. ') || title.startsWith('* ')) {
    return true
  }
  if (containsBrailleSpinner(title)) {
    // Why: Orca synthesizes `⠋ Cursor Agent` working titles for cursor-agent
    // panes (see hook listener in main/index.ts). Those titles carry a braille
    // spinner but are decidedly not Claude — the prompt-cache timer and other
    // Claude-scoped paths must not fire for them.
    if (title.toLowerCase().includes('cursor')) {
      return false
    }
    return true
  }
  // Why: permission/action-required Claude titles can omit the usual prefixes.
  // Requiring "claude" at the start avoids false positives from other agents
  // whose task text merely mentions Claude.
  if (title.toLowerCase().startsWith('claude')) {
    return true
  }

  return false
}

export function getAgentLabel(title: string): string | null {
  const lower = title.toLowerCase()

  if (isGeminiTerminalTitle(title)) {
    return 'Gemini CLI'
  }
  // Why: Pi working titles include a braille spinner prefix, which would be
  // mistaken for Claude Code if we checked `isClaudeAgent` first.
  if (isPiAgentTitle(title)) {
    return 'Pi'
  }
  // Why: Codex/OpenCode/Aider can also use braille spinner prefixes while
  // working. Prefer explicit name matches before Claude's generic spinner
  // heuristic so mixed-agent hovercards stay truthful.
  if (lower.includes('codex')) {
    return 'Codex'
  }
  if (lower.includes('copilot')) {
    return 'GitHub Copilot'
  }
  if (lower.includes('opencode')) {
    return 'OpenCode'
  }
  if (lower.includes('aider')) {
    return 'Aider'
  }
  // Why: the cursor-agent native title is the literal string "Cursor Agent"
  // (verified against the 2026.04.17 release) — Orca synthesizes the same
  // label from hook events so the braille-spinner + agent-name path lights
  // up working/permission/idle transitions in the renderer. Match before
  // `isClaudeAgent` because Claude's generic braille heuristic would
  // otherwise claim every "⠋ Cursor Agent" frame as Claude.
  if (lower.includes('cursor')) {
    return 'Cursor'
  }
  if (isClaudeAgent(title)) {
    return 'Claude Code'
  }

  return null
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

  if (containsAgentName(title)) {
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

    return 'idle'
  }

  return null
}

// Why: shared between the runtime (dispatch guard, tui-idle fallback) and the
// renderer (agent-ready-wait, new-workspace). A bare shell is the only process
// type that garbles injected preambles, so this is the negative signal for
// "is an agent running".
const SHELL_NAMES = new Set([
  '',
  'bash',
  'zsh',
  'sh',
  'fish',
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'nu'
])

export function isShellProcess(processName: string): boolean {
  return SHELL_NAMES.has(processName.trim().toLowerCase())
}
