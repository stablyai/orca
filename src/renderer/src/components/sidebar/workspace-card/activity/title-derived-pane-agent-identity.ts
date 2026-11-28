import { titleShowsNoAgent } from '../../../../../../shared/agent-status/process/shell-process-detection'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { resolveCompatibleAgentTypeForOwner } from '../../../../../../shared/agent-status/title/agent-title-owner'
import { resolveExplicitTerminalTitleAgentType } from '../../../../../../shared/agent-status/title/terminal-title-agent-type'
import type { PaneForegroundAgentEntry } from '@/store/slices/agent-status/pane-authority/pane-foreground-agent'

export const TITLE_AGENT_LABEL_TO_TYPE: Record<string, AgentType> = {
  'Claude Code': 'claude',
  OpenClaude: 'openclaude',
  Codex: 'codex',
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

export function resolveTitleDerivedAgentType(
  title: string,
  _label: string,
  _ownerAgentType?: AgentType | null
): AgentType | null {
  const admittedAgent = resolveExplicitTerminalTitleAgentType(title)
  return admittedAgent
    ? (Object.values(TITLE_AGENT_LABEL_TO_TYPE).find((agent) => agent === admittedAgent) ??
        'unknown')
    : null
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

/** The agent a live process read names for this pane; launch records and shell/default exit titles give none. */
export function processReadAgent(
  foreground: TitleDerivedPaneForeground | undefined,
  title: string,
  defaultTitle?: string
): AgentType | null {
  // Launch records lack run IDs; exit titles must override stale process reads after reattach.
  return foreground?.agentEvidence !== 'process-read' ||
    titleRetiresProcessRead({ title, defaultTitle })
    ? null
    : foreground.agent
}

/** Prefer live process evidence, then title identity, then an active launch fallback; shell/default exit titles retire process evidence. */
export function resolveTitleDerivedPaneAgent(args: {
  title: string
  defaultTitle?: string
  titleShowsActivity: boolean
  titleAgentType: AgentType | null
  launchAgentType: AgentType | null
  foreground: TitleDerivedPaneForeground | undefined
}): AgentType | null {
  const processAgent = processReadAgent(args.foreground, args.title, args.defaultTitle)
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
