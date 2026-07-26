import { stripLeadingAgentTitleDecorationOrEmpty } from './agent-title-decoration'
import { TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'
import type { TuiAgent } from './types'

const AGENT_TITLE_ALIASES: Partial<Record<TuiAgent, readonly string[]>> = {
  claude: ['Claude Code'],
  copilot: ['Copilot'],
  antigravity: ['agy'],
  gemini: ['Gemini CLI'],
  'mimo-code': ['mimo'],
  cursor: ['Cursor Agent']
}
const BRAILLE_IDENTITY_STATUS_SUFFIX_RE =
  /^(?:|\s+(?:(?:is\s+)?(?:working|thinking|running)(?:\b[\s\S]*)?|(?:ready|idle|done))|\s+-\s+action required)$/i
const WINDOWS_EXECUTABLE_SUFFIX_RE = /^\.(?:exe|cmd|bat|ps1)(?=$|[^\w./\\-])/i

/**
 * True when an agent name owns the semantic start of a terminal title rather
 * than merely appearing inside task text.
 */
export function hasLeadingExplicitAgentTitleIdentity(title: string, agent: TuiAgent): boolean {
  const content = stripLeadingAgentTitleDecorationOrEmpty(title.trim()).trimStart()
  return agentIdentityNames(agent).some((name) => identityNameRemainder(content, name) !== null)
}

/** Braille is shared by several CLIs, so only controlled status frames can own it. */
export function hasCanonicalBrailleAgentTitleIdentity(title: string, agent: TuiAgent): boolean {
  const content = stripLeadingAgentTitleDecorationOrEmpty(title.trim()).trimStart()
  return agentIdentityNames(agent).some((name) => {
    const remainder = identityNameRemainder(content, name)
    return remainder !== null && BRAILLE_IDENTITY_STATUS_SUFFIX_RE.test(remainder)
  })
}

function agentIdentityNames(agent: TuiAgent): string[] {
  return [TUI_AGENT_DISPLAY_NAMES[agent], ...(AGENT_TITLE_ALIASES[agent] ?? [])]
}

function identityNameRemainder(content: string, name: string): string | null {
  if (!content.toLowerCase().startsWith(name.toLowerCase())) {
    return null
  }
  const remainder = content.slice(name.length)
  const executableSuffix = WINDOWS_EXECUTABLE_SUFFIX_RE.exec(remainder)?.[0]
  if (executableSuffix) {
    return remainder.slice(executableSuffix.length)
  }
  const next = remainder.charAt(0)
  return next.length === 0 || !/[\w./\\-]/u.test(next) ? remainder : null
}
