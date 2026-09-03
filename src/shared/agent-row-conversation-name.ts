// Resolves the stable "conversation name" an agent row can show instead of the
// live last-message preview. Sources, in the same precedence the tab bar uses
// (tab-title-resolution.ts): manual rename → quick-command label → OpenCode's
// semantic session title → the AI Vault session title (the agent-side
// `/rename` name) → Orca's generated title → the agent-set live title.
// Live titles are accepted only when they carry a real name — pure status,
// identity-echo, and spinner/cwd titles yield null so callers keep the
// last-message label.
import type { AgentType } from './agent-status-types'
import type { AiVaultSessionTitle } from './ai-vault-session-title'
import { isClaudeManagementTitle } from './agent-title-core'
import { stripLeadingAgentTitleDecorationOrEmpty } from './agent-title-decoration'
import { formatAgentTypeLabel } from './agent-type-label'
import { isMeaningfulOpenCodeTerminalTitle } from './opencode-terminal-title'
import { SYNTHETIC_AGENT_TITLE_PROFILES } from './synthetic-agent-title'
import type { TerminalTab } from './terminal-tab-types'

export type ConversationNameTab = Pick<
  TerminalTab,
  'customTitle' | 'quickCommandLabel' | 'aiVaultTitle' | 'generatedTitle' | 'title' | 'defaultTitle'
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

/**
 * Whether the tab's AI Vault session title belongs to THIS row.
 *
 * The title is stored per tab while the row is per pane: on a split tab it may
 * name a sibling pane's session. A row proves ownership with its provider
 * session id; rows without one (title-derived fallbacks) may only borrow the
 * title on a single-pane tab, and only when the agent identity agrees.
 */
function aiVaultTitleOwnsRow(
  title: AiVaultSessionTitle,
  agentType: AgentType | null | undefined,
  providerSessionId: string | null | undefined,
  paneLiveTitle: string | null | undefined
): boolean {
  if (providerSessionId) {
    return title.sessionId === providerSessionId
  }
  return paneLiveTitle === undefined && agentType === title.agent
}

/**
 * The usable name inside an agent-set live title, or null when the title is
 * pure status/identity/cwd noise and the caller should keep its own label.
 */
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
  generatedTitlesEnabled: boolean,
  // Why: `tab.title` carries only the FOCUSED pane's title, so in a split tab it
  // names one pane and mislabels its siblings. Callers on a multi-pane tab pass
  // this row's own pane title, or `null` when none resolves; `undefined` (a
  // single-pane tab) keeps the tab title. Tab-owned names above are unaffected:
  // the user gave those to the whole tab and they do not flip on focus.
  paneLiveTitle?: string | null,
  // Why: `aiVaultTitle` is tab-scoped, so a split tab's sibling session must
  // not lend its name to this row. The row's provider session id proves which
  // session the row belongs to.
  providerSessionId?: string | null
): string | null {
  const customTitle = tab.customTitle?.trim()
  if (customTitle) {
    return customTitle
  }
  const quickCommandLabel = tab.quickCommandLabel?.trim()
  if (quickCommandLabel) {
    return quickCommandLabel
  }
  const liveTitle =
    paneLiveTitle === undefined ? (tab.title?.trim() ?? '') : (paneLiveTitle?.trim() ?? '')
  if (isMeaningfulOpenCodeTerminalTitle(liveTitle)) {
    return liveTitle
  }
  const aiVaultTitle = tab.aiVaultTitle?.title.trim()
  if (
    aiVaultTitle &&
    tab.aiVaultTitle &&
    aiVaultTitleOwnsRow(tab.aiVaultTitle, agentType, providerSessionId, paneLiveTitle)
  ) {
    return aiVaultTitle
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
