import { titleShowsNoAgent } from '../../../../shared/agent-detection'
import type { AgentType } from '../../../../shared/agent-status-types'
import { resolveCompatibleAgentTypeForOwner } from '../../../../shared/agent-title-owner'
import { isClaudeIdentityFrameTitle } from '../../../../shared/terminal-title-agent-type'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'

const TITLE_AGENT_LABEL_TO_TYPE: Record<string, AgentType> = {
  'Claude Code': 'claude',
  OpenClaude: 'openclaude',
  Codex: 'codex',
  'Gemini CLI': 'gemini',
  'GitHub Copilot': 'copilot',
  Grok: 'grok',
  Devin: 'devin',
  Jcode: 'jcode',
  Antigravity: 'antigravity',
  OpenCode: 'opencode',
  Aider: 'aider',
  Cursor: 'cursor',
  Droid: 'droid',
  Hermes: 'hermes',
  'DeepSeek Build': 'dsb',
  Pi: 'pi',
  OMP: 'omp'
}

const CLAUDE_AGENT_TOKEN_RE = /(?<![\w./\\-])claude(?![\w./\\-])/i

export function resolveTitleDerivedAgentType(
  title: string,
  label: string,
  ownerAgentType?: AgentType | null
): AgentType | null {
  const agentType = TITLE_AGENT_LABEL_TO_TYPE[label] ?? 'unknown'
  if (agentType !== 'claude') {
    return agentType
  }
  // Why: Claude's task-title spinner heuristic has no provider identity. In
  // split panes it can match arbitrary terminal spinners, so sidebar rows only
  // accept Claude when the title itself names Claude.
  if (!CLAUDE_AGENT_TOKEN_RE.test(title)) {
    return null
  }
  // Why: a "claude" word inside another agent's task text is a mention, not identity.
  // Only a title that PRESENTS Claude may take a pane away from its known owner (#8940).
  const owner = ownerAgentType && ownerAgentType !== 'unknown' ? ownerAgentType : null
  if (owner && owner !== 'claude' && !isClaudeIdentityFrameTitle(title)) {
    return null
  }
  return agentType
}

/** The pane's foreground-process read as the tracker publishes it; routing fields are omitted. */
export type TitleDerivedPaneForeground = Pick<
  PaneForegroundAgentEntry,
  'agent' | 'agentEvidence' | 'shellForeground'
>

// Why: Codex clears its title on exit (OSC 0 with no text) and the tab then shows its default title.
function titleRetiresProcessRead(args: { title: string; defaultTitle?: string }): boolean {
  return args.title.trim().length === 0 || titleShowsNoAgent(args.title, args.defaultTitle)
}

/**
 * Which agent a hook-less pane runs: a live process read (unless the title is a shell's), then the
 * title, then the agent Orca launched while the title shows activity. Sidebar-only; the tab icon
 * orders its signals differently. Null means the pane shows no agent row.
 *
 * Only the process read may keep a row whose title shows no agent activity (Codex retitles itself
 * to the project name, #23767): the mounted pane's tracker re-derives it at command boundaries,
 * which a pane without shell command marks never emits, so exit titles must still retire it. The
 * launch record is a tab-scoped latch with no run id, so it stays a fallback for titles that show
 * activity, and ranks below a title that names a different agent (pane reuse).
 */
export function resolveTitleDerivedPaneAgent(args: {
  title: string
  defaultTitle?: string
  titleShowsActivity: boolean
  titleAgentType: AgentType | null
  launchAgentType: AgentType | null
  foreground: TitleDerivedPaneForeground | undefined
}): AgentType | null {
  // Why: a shell/default title is exit evidence the process read may not have caught up with; a
  // reattach's launch record is not a read at all and can name an agent that already exited.
  const processAgent =
    args.foreground?.agentEvidence !== 'process-read' || titleRetiresProcessRead(args)
      ? null
      : args.foreground.agent
  // Why: OMP's nested pi process must not take an OMP-launched pane from its owner.
  const ownedProcessAgent = processAgent
    ? (resolveCompatibleAgentTypeForOwner(processAgent, args.launchAgentType) ?? processAgent)
    : null
  return (
    ownedProcessAgent ??
    args.titleAgentType ??
    (args.titleShowsActivity ? args.launchAgentType : null)
  )
}
