import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { getSharedProjectAttentionFromState } from './project-attention-order'

type SharedState = Parameters<typeof getSharedProjectAttentionFromState>[0]

function makeState(): SharedState {
  return {
    worktreesByRepo: {} as AppState['worktreesByRepo'],
    tabsByWorktree: {},
    agentStatusByPaneKey: {},
    runtimePaneTitlesByTabId: {},
    ptyIdsByTabId: {},
    migrationUnsupportedByPtyId: {},
    terminalLayoutsByTabId: {}
  }
}

describe('getSharedProjectAttentionFromState', () => {
  it('reuses one computation while inputs and clock are unchanged', () => {
    // Why: every compact project header calls this from its selector on each store write.
    const state = makeState()
    const first = getSharedProjectAttentionFromState(state, 1_000)
    expect(getSharedProjectAttentionFromState({ ...state }, 1_000)).toBe(first)
  })

  it('recomputes when an attention input or the clock changes', () => {
    const state = makeState()
    const first = getSharedProjectAttentionFromState(state, 1_000)
    const afterTitle = getSharedProjectAttentionFromState(
      { ...state, runtimePaneTitlesByTabId: {} },
      1_000
    )
    expect(afterTitle).not.toBe(first)
    const afterTick = getSharedProjectAttentionFromState({ ...state }, 61_000)
    expect(afterTick).not.toBe(afterTitle)
  })
})
