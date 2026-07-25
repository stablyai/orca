import { describe, expect, it } from 'vitest'
import { resolvePetBoundNoteTarget } from './pet-bound-session'

const LEAF = 'ed140e4c-337a-4ac6-b034-7bcb9cdccca7'
const SESSION = { tabId: 'tab-1', worktreeId: 'repo::/w' }

function state(
  overrides: {
    layouts?: Record<string, { activeLeafId: string | null } | undefined>
    tabs?: Record<string, readonly { id: string }[] | undefined>
  } = {}
): Parameters<typeof resolvePetBoundNoteTarget>[1] {
  return {
    terminalLayoutsByTabId: overrides.layouts ?? { 'tab-1': { activeLeafId: LEAF } },
    tabsByWorktree: overrides.tabs ?? { 'repo::/w': [{ id: 'tab-1' }] }
  }
}

describe('resolvePetBoundNoteTarget', () => {
  it('is null when the pet has no assistant', () => {
    expect(resolvePetBoundNoteTarget(null, state())).toBeNull()
  })

  it('addresses the bound tab even before the assistant has reported', () => {
    // The whole point of the binding: an omp pane reports no agent status until
    // its first prompt, so this must work with zero AgentStatusEntry involved.
    expect(resolvePetBoundNoteTarget(SESSION, state())).toEqual({
      worktreeId: 'repo::/w',
      noteTarget: { tabId: 'tab-1', leafId: LEAF }
    })
  })

  it('forgets a closed tab rather than offering a dead ask', () => {
    // The mutation that matters: skip the tab-still-open check and the pet
    // keeps offering to ask a session the user closed, silently sending
    // prompts nowhere and never re-offering to spawn a replacement.
    expect(resolvePetBoundNoteTarget(SESSION, state({ tabs: { 'repo::/w': [] } }))).toBeNull()
  })

  it('declines a tab whose layout has no active leaf', () => {
    expect(
      resolvePetBoundNoteTarget(SESSION, state({ layouts: { 'tab-1': { activeLeafId: null } } }))
    ).toBeNull()
  })
})
