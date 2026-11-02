import { useAppStore } from '@/store'
import { resolveCommittedTitleAgentType } from '@/lib/pane-agent-evidence'
import { resolveCompatibleAgentTypeForOwner } from '../../../shared/agent-title-owner'
import { isAgentStatusHooksEnabledForAgent } from '../../../shared/agent-status-hooks-setting'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import type { TerminalAgent } from '../../../shared/terminal-agent'
import { hookLaneCanAnnouncePaneTurnEnd } from './agent-hook-completion-notifications'
import { hookTurnEndEvidence } from './agent-hook-turn-end-capability'

/** Resolve hook authority for this agent’s end: identified announces via hooks, ambiguous retains title fallback. Title-only spins or quitting after an identified end do not end another hook turn. */
export function hookLaneTurnEndEvidence(
  paneKey: string,
  ptyId: string | null | undefined,
  agent: TerminalAgent | null
): 'identified' | 'ambiguous' | null {
  const { agentStatusByPaneKey, settings } = useAppStore.getState()
  const row = agentStatusByPaneKey[paneKey]
  const owner = row?.agentType
  const evidence = hookTurnEndEvidence(ptyId, row)
  // Title authority remains for unfinished turns and agents whose hooks were uninstalled.
  if (
    row?.state !== 'done' ||
    evidence === 'legacy' ||
    !isTuiAgent(owner) ||
    !isAgentStatusHooksEnabledForAgent(settings, owner) ||
    !hookLaneCanAnnouncePaneTurnEnd(paneKey)
  ) {
    return null
  }
  return !agent || resolveCompatibleAgentTypeForOwner(owner, agent) === agent ? evidence : null
}

export function hookLaneOwnsAgentTurnEnds(
  paneKey: string,
  ptyId: string | null | undefined,
  agent: TerminalAgent | null
): boolean {
  return hookLaneTurnEndEvidence(paneKey, ptyId, agent) === 'identified'
}

/** Resolve idle/working title edges to the title’s agent, falling back to the pane’s foreground agent. */
export function hookLaneTitleTurnEndEvidence(
  paneKey: string,
  ptyId: string | null | undefined,
  title: string | null,
  foregroundAgent: TerminalAgent | null
): 'identified' | 'ambiguous' | null {
  const agent = (title ? resolveCommittedTitleAgentType(title) : null) ?? foregroundAgent
  return hookLaneTurnEndEvidence(paneKey, ptyId, agent)
}
