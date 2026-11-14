// Uses the tab's own name order, then a live title only when it names the conversation, so rows retain message previews.
import type { AgentType } from '../contracts/agent-status-types'
import { isClaudeManagementTitle } from '../title/agent-title-core'
import { stripLeadingAgentTitleDecorationOrEmpty } from '../title/agent-title-decoration'
import { formatAgentTypeLabel } from './agent-type-label'
import { isJcodeIdentityTerminalTitle } from '../title/providers/jcode-terminal-title'
import { SYNTHETIC_AGENT_TITLE_PROFILES } from '../title/synthetic-agent-title'
import type { TerminalTab } from '../../workspace-layout/terminal-tab-types'
import { resolveTabNameSource } from '../../tab-title-resolution'
import { aiVaultTitleOfSession } from '../../ai-vault/contracts/ai-vault-session-title'

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
  const liveTitle =
    paneLiveTitle === undefined ? (tab.title?.trim() ?? '') : (paneLiveTitle?.trim() ?? '')
  const named = resolveTabNameSource(
    {
      customTitle: tab.customTitle,
      quickCommandLabel: tab.quickCommandLabel,
      liveTitle,
      sessionTitle: aiVaultTitleOfSession(tab.aiVaultTitle, agentType, providerSessionId),
      generatedTitle: tab.generatedTitle
    },
    generatedTitlesEnabled
  )
  if (named) {
    return named
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
