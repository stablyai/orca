import { describe, expect, it } from 'vitest'
import { buildPetAskRequest } from './pet-agent-ask'
import type { PetAgentTarget } from './pet-agent-jump'

// Real paneKeys are `${tabId}:${uuid}` — parsePaneKey rejects a non-UUID leaf.
const LEAF = 'ed140e4c-337a-4ac6-b034-7bcb9cdccca7'

function target(overrides: Partial<PetAgentTarget> = {}): PetAgentTarget {
  return {
    paneKey: `tab-1:${LEAF}`,
    agentType: 'omp',
    worktreeId: 'repo::/w',
    ...overrides
  }
}

describe('buildPetAskRequest', () => {
  it('has nothing to ask when the pet has no target', () => {
    expect(buildPetAskRequest(null)).toBeNull()
  })

  it('addresses the exact pane the pet is talking about', () => {
    // The mutation this pins: dropping leafId (or substituting the active
    // pane's) still "sends" — it just sends to the wrong split. The pet
    // routinely points at a pane that is NOT focused, so an implicit target
    // would land the prompt in whatever the user happens to be looking at.
    expect(buildPetAskRequest(target())).toEqual({
      worktreeId: 'repo::/w',
      noteTarget: { tabId: 'tab-1', leafId: LEAF }
    })
  })

  it('carries the target worktree, not the active one', () => {
    // Cross-repo asks must be routed by the target's own worktreeId, because
    // sendNotesToActiveAgentSession resolves the owner host from it — get this
    // wrong and a remote agent's prompt is typed on the local box.
    const request = buildPetAskRequest(target({ worktreeId: 'other::/elsewhere' }))
    expect(request?.worktreeId).toBe('other::/elsewhere')
  })

  it('refuses an unparseable paneKey rather than guessing a pane', () => {
    expect(buildPetAskRequest(target({ paneKey: 'tab-1:not-a-uuid' }))).toBeNull()
    expect(buildPetAskRequest(target({ paneKey: 'garbage' }))).toBeNull()
  })
})
