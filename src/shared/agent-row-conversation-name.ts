// Resolves the stable "conversation name" an agent row can show instead of the
// live last-message preview. Sources, in the same precedence the tab bar uses
// (tab-title-resolution.ts): manual rename → quick-command label → OpenCode's
// semantic session title → Orca's generated title → the agent-set live title.
// Live titles are accepted only when they carry a real name — pure status,
// identity-echo, and spinner/cwd titles yield null so callers keep the
// last-message label.
import type { AgentType } from './agent-status-types'
import { isClaudeManagementTitle } from './agent-title-core'
import { stripLeadingAgentTitleDecorationOrEmpty } from './agent-title-decoration'
import { formatAgentTypeLabel } from './agent-type-label'
import { isMeaningfulOpenCodeTerminalTitle } from './opencode-terminal-title'
import { SYNTHETIC_AGENT_TITLE_PROFILES } from './synthetic-agent-title'
import type { TerminalTab } from './types'

export type ConversationNameTab = Pick<
  TerminalTab,
  'customTitle' | 'quickCommandLabel' | 'generatedTitle' | 'title' | 'defaultTitle'
>

// Why: synthetic status titles ("Codex ready", "Cursor - action required") are
// state, not names. Precomputed once; the profile table is a module constant.
const SYNTHETIC_STATUS_TITLES_LOWER: ReadonlySet<string> = new Set(
  Object.values(SYNTHETIC_AGENT_TITLE_PROFILES).flatMap((profile) => [
    profile.workingLabel.toLowerCase(),
    profile.permissionLabel.toLowerCase(),
    profile.idleLabel.toLowerCase()
  ])
)

// Why: retained rows without a live tab synthesize `title: 'Agent'`
// (worktree-agent-row-fallback-tab.ts); it is a placeholder, not a name.
const FALLBACK_TAB_TITLE_LOWER = 'agent'

const AGENT_IDENTITY_ALIASES_LOWER: Readonly<Record<string, readonly string[]>> = {
  claude: ['claude code'],
  gemini: ['gemini cli']
}

const STATUS_WITH_CONTEXT_RE = /^(?:ready|idle|done)(?:\s+\([^)]*\))?$/i
const DEFAULT_TERMINAL_TITLE_RE = /^terminal \d+$/i

function isIdentityStatusTitle(titleLower: string, identityLower: string): boolean {
  return (
    titleLower === identityLower ||
    titleLower === `${identityLower} ready` ||
    titleLower === `${identityLower} idle` ||
    titleLower === `${identityLower} done` ||
    titleLower === `${identityLower} working` ||
    titleLower === `${identityLower} thinking` ||
    titleLower === `${identityLower} running` ||
    titleLower === `${identityLower} - action required`
  )
}

function isAgentIdentityStatusTitle(
  titleLower: string,
  agentType: AgentType | null | undefined,
  agentTypeLabelLower: string
): boolean {
  if (isIdentityStatusTitle(titleLower, agentTypeLabelLower)) {
    return true
  }
  return (
    AGENT_IDENTITY_ALIASES_LOWER[agentType ?? '']?.some((identity) =>
      isIdentityStatusTitle(titleLower, identity)
    ) ?? false
  )
}

function isCwdLikeTitle(title: string): boolean {
  // Hook-less agents over SSH surface spinner+cwd titles (#8711); once the
  // spinner is stripped, what remains is a path, not a conversation name.
  if (/^(?:~|[\\/]|[A-Za-z]:[\\/])/.test(title)) {
    return true
  }
  // A single path-ish token ("orca/workspaces") is still a cwd, not a name.
  return !/\s/.test(title) && /[\\/]/.test(title)
}

function conversationNameFromLiveTitle(
  liveTitle: string,
  agentType: AgentType | null | undefined,
  agentTypeLabelLower: string,
  defaultTitle: string | undefined
): string | null {
  const stripped = stripLeadingAgentTitleDecorationOrEmpty(liveTitle.trim()).trim()
  if (!stripped) {
    return null
  }
  const lower = stripped.toLowerCase()
  if (
    SYNTHETIC_STATUS_TITLES_LOWER.has(lower) ||
    lower === FALLBACK_TAB_TITLE_LOWER ||
    isAgentIdentityStatusTitle(lower, agentType, agentTypeLabelLower) ||
    STATUS_WITH_CONTEXT_RE.test(stripped) ||
    DEFAULT_TERMINAL_TITLE_RE.test(stripped) ||
    isClaudeManagementTitle(stripped) ||
    isCwdLikeTitle(stripped)
  ) {
    return null
  }
  if (defaultTitle && stripped === defaultTitle.trim()) {
    return null
  }
  return stripped
}

/**
 * The conversation name for an agent row, or null when no usable name exists
 * and the caller should keep its last-message label.
 */
export function getAgentRowConversationName(
  tab: ConversationNameTab,
  agentType: AgentType | null | undefined,
  generatedTitlesEnabled: boolean
): string | null {
  const customTitle = tab.customTitle?.trim()
  if (customTitle) {
    return customTitle
  }
  const quickCommandLabel = tab.quickCommandLabel?.trim()
  if (quickCommandLabel) {
    return quickCommandLabel
  }
  const liveTitle = tab.title?.trim() ?? ''
  if (isMeaningfulOpenCodeTerminalTitle(liveTitle)) {
    return liveTitle
  }
  const generatedTitle = generatedTitlesEnabled ? tab.generatedTitle?.trim() : ''
  if (generatedTitle) {
    return generatedTitle
  }
  if (!liveTitle) {
    return null
  }
  return conversationNameFromLiveTitle(
    liveTitle,
    agentType,
    formatAgentTypeLabel(agentType).toLowerCase(),
    tab.defaultTitle
  )
}
