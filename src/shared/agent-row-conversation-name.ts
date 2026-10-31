// Follow tab-title-resolution precedence: manual, quick command, semantic, provider, generated, then live title. Reject status/identity/cwd live titles so rows retain message previews.
import type { AgentType } from './agent-status-types'
import { isClaudeManagementTitle } from './agent-title-core'
import { stripLeadingAgentTitleDecorationOrEmpty } from './agent-title-decoration'
import { formatAgentTypeLabel } from './agent-type-label'
import { isJcodeIdentityTerminalTitle } from './jcode-terminal-title'
import { isMeaningfulOpenCodeTerminalTitle } from './opencode-terminal-title'
import { SYNTHETIC_AGENT_TITLE_PROFILES } from './synthetic-agent-title'
import type { TerminalTab } from './terminal-tab-types'

export type ConversationNameTab = Pick<
  TerminalTab,
  'customTitle' | 'quickCommandLabel' | 'aiVaultTitle' | 'generatedTitle' | 'title' | 'defaultTitle'
>

// Synthetic status labels describe state rather than a conversation name.
const SYNTHETIC_STATUS_TITLES_LOWER: ReadonlySet<string> = new Set(
  Object.values(SYNTHETIC_AGENT_TITLE_PROFILES).flatMap((profile) => [
    profile.workingLabel.toLowerCase(),
    profile.permissionLabel.toLowerCase(),
    profile.idleLabel.toLowerCase()
  ])
)

// Retained-tab fallback Agent is a placeholder, never a conversation name.
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
  // Hookless SSH titles may contain only spinner+cwd, never a conversation name (#8711).
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
    // jcode repaints codename/diff/duration each second; accepting that identity hides the prompt preview.
    isJcodeIdentityTerminalTitle(stripped) ||
    isCwdLikeTitle(stripped)
  ) {
    return null
  }
  if (defaultTitle && stripped === defaultTitle.trim()) {
    return null
  }
  return stripped
}

/** Return null without a usable name so the row retains its last-message label. */
export function getAgentRowConversationName(
  tab: ConversationNameTab,
  agentType: AgentType | null | undefined,
  generatedTitlesEnabled: boolean,
  // Tab live title names the focused pane; split callers supply their own title/null. Undefined retains single-pane behavior; tab-owned names still apply.
  paneLiveTitle?: string | null,
  providerSessionId?: string
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
  // Provider titles belong to their session, not every pane in the tab.
  const aiVaultTitle = tab.aiVaultTitle
  const providerTitle = aiVaultTitle?.title.trim()
  if (
    aiVaultTitle &&
    providerTitle &&
    aiVaultTitle.agent === agentType &&
    aiVaultTitle.sessionId === providerSessionId
  ) {
    return providerTitle
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
