// Resolves the stable "conversation name" an agent row can show instead of the
// live last-message preview. Sources, in the same precedence the tab bar uses
// (tab-title-resolution.ts): manual rename → quick-command label → OpenCode's
// semantic session title → a meaningful agent-set live title → Orca's
// generated first-prompt title. Live titles are accepted only when they carry
// a real name — pure status, identity-echo, and spinner/cwd titles yield null
// so the generated fallback (or the caller's last-message label) can win.
import type { AgentType } from './agent-status-types'
import { isClaudeManagementTitle } from './agent-title-core'
import { stripLeadingAgentTitleDecorationOrEmpty } from './agent-title-decoration'
import { formatAgentTypeLabel, WELL_KNOWN_AGENT_TYPE_LABELS } from './agent-type-label'
import { isMeaningfulOpenCodeTerminalTitle } from './opencode-terminal-title'
import { SYNTHETIC_AGENT_TITLE_PROFILES } from './synthetic-agent-title'
import { isGrokRotatingWorkingTitle } from './terminal-title-agent-type'
import type { TerminalTab } from './terminal-tab-types'

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

// Why: Claude OSC is "Claude working"; Codex's stored working title is
// "Codex is thinking". Both must lose to a generated conversation name.
const IDENTITY_STATUS_SUFFIXES = [
  '',
  ' ready',
  ' idle',
  ' done',
  ' working',
  ' thinking',
  ' running',
  ' is ready',
  ' is idle',
  ' is done',
  ' is working',
  ' is thinking',
  ' is running',
  ' - action required'
] as const

const KNOWN_IDENTITY_STATUS_TITLES_LOWER: ReadonlySet<string> = new Set(
  [
    FALLBACK_TAB_TITLE_LOWER,
    ...Object.values(WELL_KNOWN_AGENT_TYPE_LABELS).map((label) => label.toLowerCase()),
    ...Object.values(AGENT_IDENTITY_ALIASES_LOWER).flat()
  ].flatMap((identity) => IDENTITY_STATUS_SUFFIXES.map((suffix) => `${identity}${suffix}`))
)

const STATUS_WITH_CONTEXT_RE = /^(?:ready|idle|done)(?:\s+\([^)]*\))?$/i
const DEFAULT_TERMINAL_TITLE_RE = /^terminal \d+$/i

function isIdentityStatusTitle(titleLower: string, identityLower: string): boolean {
  return IDENTITY_STATUS_SUFFIXES.some((suffix) => titleLower === `${identityLower}${suffix}`)
}

function isAgentIdentityStatusTitle(titleLower: string, agentTypeLabelLower: string): boolean {
  // Why: the Set covers well-known labels when the tab bar passes no agent type.
  return (
    KNOWN_IDENTITY_STATUS_TITLES_LOWER.has(titleLower) ||
    isIdentityStatusTitle(titleLower, agentTypeLabelLower)
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

export function conversationNameFromLiveTitle(
  liveTitle: string,
  agentType: AgentType | null | undefined,
  defaultTitle?: string
): string | null {
  const original = liveTitle.trim()
  const stripped = stripLeadingAgentTitleDecorationOrEmpty(original).trim()
  if (!stripped) {
    return null
  }
  // Why: rotating Grok frames keep the spinner; classify before stripping.
  if (isGrokRotatingWorkingTitle(original)) {
    return null
  }
  const lower = stripped.toLowerCase()
  const agentTypeLabelLower = formatAgentTypeLabel(agentType).toLowerCase()
  if (
    SYNTHETIC_STATUS_TITLES_LOWER.has(lower) ||
    lower === FALLBACK_TAB_TITLE_LOWER ||
    isAgentIdentityStatusTitle(lower, agentTypeLabelLower) ||
    STATUS_WITH_CONTEXT_RE.test(stripped) ||
    DEFAULT_TERMINAL_TITLE_RE.test(stripped) ||
    isClaudeManagementTitle(stripped) ||
    isCwdLikeTitle(stripped)
  ) {
    return null
  }
  // Why: spinner + a single token is a project/cwd OSC frame ("⠋ albacore"),
  // not a conversation name. Multi-word decorated titles still count.
  if (stripped !== original && !/\s/.test(stripped)) {
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
  paneLiveTitle?: string | null
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
  const namedLiveTitle = liveTitle
    ? conversationNameFromLiveTitle(liveTitle, agentType, tab.defaultTitle)
    : null
  if (namedLiveTitle) {
    return namedLiveTitle
  }
  const generatedTitle = generatedTitlesEnabled ? tab.generatedTitle?.trim() : ''
  if (generatedTitle) {
    return generatedTitle
  }
  return null
}
