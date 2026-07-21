import { useCallback } from 'react'
import { toast } from 'sonner'
import {
  activeAgentNotesSendFailureMessage,
  sendNotesToActiveAgentSession
} from '@/lib/active-agent-note-send'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { PetAgentTarget } from './pet-agent-jump'

/** Everything `sendNotesToActiveAgentSession` needs to reach the pet's agent. */
export type PetAskRequest = {
  worktreeId: string
  noteTarget: { tabId: string; leafId: string }
}

/**
 * Turn the pet's current agent target into an addressed send.
 *
 * Split from the hook so the routing rule is testable without React: the whole
 * risk here is addressing the *wrong* pane, and that is a pure function of the
 * target's paneKey.
 *
 * Returns null on an unparseable key. Callers should omit the menu item rather
 * than offer an ask that would silently land somewhere else — the same rule
 * `selectPetAgentTarget` follows for the jump.
 */
export function buildPetAskRequest(target: PetAgentTarget | null): PetAskRequest | null {
  if (!target) {
    return null
  }
  const parsed = parsePaneKey(target.paneKey)
  if (!parsed) {
    return null
  }
  return {
    worktreeId: target.worktreeId,
    noteTarget: { tabId: parsed.tabId, leafId: parsed.leafId }
  }
}

/**
 * The pet's "ask" binding: deliver a prompt to the agent the pet is talking about.
 *
 * Why this reuses `sendNotesToActiveAgentSession` wholesale rather than writing
 * to the pty: that path already resolves the worktree's *owner host* before
 * sending, so an ask aimed at an SSH/remote worktree is driven on the machine
 * that actually runs the agent. It also brackets the paste and waits out the
 * submit delay. A direct pane write would be correct only for local panes and
 * would quietly corrupt or drop remote ones.
 *
 * Always passes an explicit target — the pet points at a specific pane, which is
 * frequently NOT the focused one, and the implicit path resolves to whatever is
 * focused.
 */
export function usePetAgentAsk(target: PetAgentTarget | null): {
  canAsk: boolean
  askAgent: (prompt: string) => Promise<void>
} {
  const request = buildPetAskRequest(target)

  const askAgent = useCallback(
    async (prompt: string): Promise<void> => {
      if (!request || !prompt.trim()) {
        return
      }
      const result = await sendNotesToActiveAgentSession({
        worktreeId: request.worktreeId,
        prompt,
        noteTarget: request.noteTarget
      })
      if (result.status !== 'sent') {
        // explicitTarget: the pet always addresses a chosen pane, so the
        // "selected" wording is the honest one for every failure here.
        toast.message(activeAgentNotesSendFailureMessage(result.status, { explicitTarget: true }))
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [request?.worktreeId, request?.noteTarget.tabId, request?.noteTarget.leafId]
  )

  return { canAsk: request !== null, askAgent }
}
