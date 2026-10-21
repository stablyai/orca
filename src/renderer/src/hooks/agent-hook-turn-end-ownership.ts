import { useAppStore } from '@/store'
import { resolveCommittedTitleAgentType } from '@/lib/pane-agent-evidence'
import { resolveCompatibleAgentTypeForOwner } from '../../../shared/agent-title-owner'
import { isAgentStatusHooksEnabledForAgent } from '../../../shared/agent-status-hooks-setting'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import type { TerminalAgent } from '../../../shared/terminal-agent'
import { hookLaneCanAnnouncePaneTurnEnd } from './agent-hook-completion-notifications'
import { hookTurnEndEvidence } from './agent-hook-turn-end-capability'

/**
 * The evidence of the hook-lane turn end a title or process naming `agent` (null: none) would
 * otherwise announce: `identified` (the hook lane announces it), `ambiguous` (main's title role
 * stays), or null (not a hook-lane turn end). A title spin (Claude's /btw, Codex's /compact) or
 * quitting the agent after an identified end ends no hook turn, so it must not announce one.
 */
export function hookLaneTurnEndEvidence(
  paneKey: string,
  ptyId: string | null | undefined,
  agent: TerminalAgent | null
): 'identified' | 'ambiguous' | null {
  const { agentStatusByPaneKey, settings } = useAppStore.getState()
  const row = agentStatusByPaneKey[paneKey]
  const owner = row?.agentType
  const evidence = hookTurnEndEvidence(ptyId, row)
  // Why: the title lane stays the fallback for an unfinished turn, and once the agent's hooks are
  // switched off (they are uninstalled, so the hook lane never hears another turn end).
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

/** A title edge's turn belongs to the title's agent, else the pane's foreground agent (goose
 *  after Claude), the same on idle and working edges. */
export function hookLaneTitleTurnEndEvidence(
  paneKey: string,
  ptyId: string | null | undefined,
  title: string | null,
  foregroundAgent: TerminalAgent | null
): 'identified' | 'ambiguous' | null {
  const agent = (title ? resolveCommittedTitleAgentType(title) : null) ?? foregroundAgent
  return hookLaneTurnEndEvidence(paneKey, ptyId, agent)
}
