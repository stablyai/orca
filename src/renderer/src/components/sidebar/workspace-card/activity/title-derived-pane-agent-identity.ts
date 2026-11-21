import { titleShowsNoAgent } from '../../../../../../shared/agent-status/process/shell-process-detection'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { resolveCompatibleAgentTypeForOwner } from '../../../../../../shared/agent-status/title/agent-title-owner'
import { resolveExplicitTerminalTitleAgentType } from '../../../../../../shared/agent-status/title/terminal-title-agent-type'
import type { PaneForegroundAgentEntry } from '@/store/slices/agent-status/pane-authority/pane-foreground-agent'

export function resolveTitleDerivedAgentType(title: string): AgentType | null {
  return resolveExplicitTerminalTitleAgentType(title)
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

/** Prefer live process evidence, then title identity, then an active launch fallback; shell/default exit titles retire process evidence. */
export function resolveTitleDerivedPaneAgent(args: {
  title: string
  defaultTitle?: string
  titleShowsActivity: boolean
  titleAgentType: AgentType | null
  launchAgentType: AgentType | null
  foreground: TitleDerivedPaneForeground | undefined
}): AgentType | null {
  if (
    !args.titleShowsActivity &&
    (args.foreground?.shellForeground === true || titleRetiresProcessRead(args))
  ) {
    return null
  }
  // Launch records lack run IDs; exit titles must override stale process reads after reattach.
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
