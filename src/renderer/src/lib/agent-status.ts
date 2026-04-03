export type AgentStatus = 'working' | 'permission' | 'idle'

const CLAUDE_IDLE = '\u2733' // ✳ (eight-spoked asterisk — Claude Code idle prefix)

const GEMINI_WORKING = '\u2726' // ✦
const GEMINI_SILENT_WORKING = '\u23F2' // ⏲
const GEMINI_IDLE = '\u25C7' // ◇
const GEMINI_PERMISSION = '\u270B' // ✋

const AGENT_NAMES = ['claude', 'codex', 'gemini', 'opencode', 'aider']

export function isGeminiTerminalTitle(title: string): boolean {
  return (
    title.includes(GEMINI_PERMISSION) ||
    title.includes(GEMINI_WORKING) ||
    title.includes(GEMINI_SILENT_WORKING) ||
    title.includes(GEMINI_IDLE) ||
    title.toLowerCase().includes('gemini')
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

function containsAny(title: string, words: string[]): boolean {
  const lower = title.toLowerCase()
  return words.some((word) => lower.includes(word))
}

const WORKING_KEYWORDS = ['working', 'thinking', 'running']

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
    for (const keyword of WORKING_KEYWORDS) {
      cleaned = cleaned.replace(new RegExp(`\\b${keyword}\\b`, 'gi'), '')
    }
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
export function createAgentStatusTracker(onBecameIdle: (title: string) => void): {
  handleTitle: (title: string) => void
} {
  let lastStatus: AgentStatus | null = null

  return {
    handleTitle(title: string): void {
      const newStatus = detectAgentStatusFromTitle(title)
      if (lastStatus === 'working' && newStatus !== null && newStatus !== 'working') {
        onBecameIdle(title)
      }
      if (newStatus !== null) {
        lastStatus = newStatus
      }
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

  return title
}

export function detectAgentStatusFromTitle(title: string): AgentStatus | null {
  if (!title) {
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

  if (containsBrailleSpinner(title)) {
    return 'working'
  }

  if (containsAgentName(title)) {
    if (containsAny(title, ['action required', 'permission', 'waiting'])) {
      return 'permission'
    }
    if (containsAny(title, ['ready', 'idle', 'done'])) {
      return 'idle'
    }
    if (containsAny(title, ['working', 'thinking', 'running'])) {
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
