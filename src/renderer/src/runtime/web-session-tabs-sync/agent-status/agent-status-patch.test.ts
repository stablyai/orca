// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'
import { isUnresolvedAgentStatus } from './agent-status-primitives'
import { buildMirroredAgentStatusPatch } from './agent-status-patch'
import { ENV, NOW, WT, makeState } from '../testing/web-session-tabs-sync.test-fixture'

const SURFACE_TAB_ID = toWebTerminalSurfaceTabId('host-tab-blocked')
const PANE_KEY = makePaneKey(SURFACE_TAB_ID, '11111111-1111-4111-8111-111111111111')

function blockedEntry(): AgentStatusEntry {
  return {
    state: 'blocked',
    worktreeId: WT,
    connectionId: ENV,
    paneKey: PANE_KEY,
    tabId: SURFACE_TAB_ID,
    updatedAt: NOW
  } as unknown as AgentStatusEntry
}

describe('isUnresolvedAgentStatus', () => {
  it('treats waiting and blocked as unresolved work', () => {
    expect(isUnresolvedAgentStatus({ state: 'waiting' } as AgentStatusEntry)).toBe(true)
    expect(isUnresolvedAgentStatus({ state: 'blocked' } as AgentStatusEntry)).toBe(true)
  })

  it('does not treat settled or working states as unresolved', () => {
    expect(isUnresolvedAgentStatus({ state: 'done' } as AgentStatusEntry)).toBe(false)
    expect(isUnresolvedAgentStatus({ state: 'working' } as AgentStatusEntry)).toBe(false)
    expect(isUnresolvedAgentStatus(undefined)).toBe(false)
  })
})

describe('buildMirroredAgentStatusPatch pending-row retention (#22445)', () => {
  it('keeps a blocked row when the host omits it after pane disposal', () => {
    const entry = blockedEntry()
    // Minimal read handle: the patch only calls get() and keysForTab(), and
    // the delete branch (replace) must be skipped by the guard under test.
    const statusByPaneKey = new Map([[PANE_KEY, entry]]) as unknown as Map<
      string,
      AgentStatusEntry
    > & {
      keysForTab: (tabId: string) => IterableIterator<string>
    }
    statusByPaneKey.keysForTab = (tabId) =>
      tabId === SURFACE_TAB_ID ? [PANE_KEY].values() : [][Symbol.iterator]()
    const state = makeState({
      agentStatusByPaneKey: statusByPaneKey as never
    })

    const patch = buildMirroredAgentStatusPatch(
      state,
      [{ id: SURFACE_TAB_ID } as never],
      [],
      [],
      ENV,
      WT,
      new Set(),
      NOW
    )

    // No patch means no deletion: the blocked row survives host omission.
    expect(patch).toBeNull()
  })
})
