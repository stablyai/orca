import { useCallback } from 'react'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { selectPetBubbleWinner } from '../../../../shared/pet-bubble-text'

/** Who the pet is currently talking about, resolved to something actionable. */
export type PetAgentTarget = {
  paneKey: string
  agentType: string | undefined
  worktreeId: string
}

/**
 * The agent a right-click on the pet should act on.
 *
 * Deliberately reuses `selectPetBubbleWinner` rather than running its own
 * "which agent matters" rule: the pet already answers that question for the
 * sprite pose and the bubble text, and a second, subtly different answer is how
 * you get a pet that says "codex is waiting" and jumps you to claude.
 *
 * Returns null when there is no fresh winner, or when the winner cannot be
 * focused (unparseable key, or no worktree attributed yet — orchestration
 * status can land before the renderer knows the pane's tab). Callers should
 * render no menu item rather than a dead one.
 */
export function selectPetAgentTarget(
  entries: readonly AgentStatusEntry[],
  now: number,
  staleAfterMs: number = AGENT_STATUS_STALE_AFTER_MS
): PetAgentTarget | null {
  const winner = selectPetBubbleWinner(entries, now, staleAfterMs)
  if (!winner) {
    return null
  }
  if (!parsePaneKey(winner.paneKey)) {
    return null
  }
  const worktreeId = entries.find((entry) => entry.paneKey === winner.paneKey)?.worktreeId
  if (!worktreeId) {
    return null
  }
  return { paneKey: winner.paneKey, agentType: winner.agentType, worktreeId }
}

/**
 * The pet's right-click binding: who to act on, and how to get there.
 *
 * Split out of PetOverlay for the same reason usePetPointerInteraction and
 * usePetRoam are — the overlay is a renderer, and navigation policy is not
 * rendering. Returns a null target when nothing is actionable so the caller can
 * omit the menu entirely.
 */
export function usePetAgentJump(entries: readonly AgentStatusEntry[]): {
  agentTarget: PetAgentTarget | null
  jumpToAgent: () => void
} {
  // Not memoized on `entries` alone: freshness decays with the clock, so a memo
  // keyed only on the entry set would keep offering a jump to a stale agent.
  const agentTarget = selectPetAgentTarget(entries, Date.now(), AGENT_STATUS_STALE_AFTER_MS)

  const jumpToAgent = useCallback((): void => {
    if (!agentTarget) {
      return
    }
    const parsed = parsePaneKey(agentTarget.paneKey)
    if (!parsed) {
      return
    }
    // Why route through activateAndRevealWorktree: the same rule the sidebar
    // agent rows follow — cross-repo jumps must also set activeRepoId, record
    // nav history, clear filters and reveal the card. Calling
    // activateTabAndFocusPane alone silently skips all of that when the pet
    // points at a pane in another repo.
    activateAndRevealWorktree(agentTarget.worktreeId)
    activateTabAndFocusPane(parsed.tabId, parsed.leafId, {
      ackPaneKeyOnSuccess: agentTarget.paneKey,
      flashFocusedPane: true,
      scrollToBottomIfOutputSinceLastView: true
    })
  }, [agentTarget])

  return { agentTarget, jumpToAgent }
}
