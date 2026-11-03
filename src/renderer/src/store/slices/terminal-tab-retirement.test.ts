import { describe, expect, it } from 'vitest'

import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import '../../../../shared/constants'
import '../../../../shared/ephemeral-setup-terminal-worktree-id'
import '../../../../shared/workspace-scope'
import type { buildTerminalTabRetirementPlan } from './terminal-tab-retirement'
import { buildTerminalTabRetirementPlans } from './terminal-tab-retirement'

type RetirementState = Parameters<typeof buildTerminalTabRetirementPlan>[0]

function makeTab(id: string, worktreeId: string, ptyId: string | null): TerminalTab {
  return {
    id,
    worktreeId,
    ptyId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeState(overrides: Partial<RetirementState> = {}): RetirementState {
  return {
    worktreesByRepo: {
      repo: [
        { id: 'wt-1', repoId: 'repo', hostId: 'local' },
        { id: 'wt-2', repoId: 'repo', hostId: 'local' }
      ]
    },
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    lastKnownRelayPtyIdByTabId: {},
    deferredSshSessionIdsByTabId: {},
    pendingReconnectPtyIdByTabId: {},
    ...overrides
  }
}

describe('terminal tab retirement planning', () => {
  it('indexes live owners once for a 100-tab batch', () => {
    const tabs = Array.from({ length: 100 }, (_, index) =>
      makeTab(`tab-${index}`, 'wt-1', `pty-${index}`)
    )
    let terminalStoreScans = 0
    let unifiedStoreScans = 0
    const state = makeState({
      tabsByWorktree: new Proxy(
        { 'wt-1': tabs },
        {
          ownKeys(target) {
            terminalStoreScans += 1
            return Reflect.ownKeys(target)
          }
        }
      ),
      unifiedTabsByWorktree: new Proxy(
        {},
        {
          ownKeys(target) {
            unifiedStoreScans += 1
            return Reflect.ownKeys(target)
          }
        }
      ),
      ptyIdsByTabId: Object.fromEntries(tabs.map((tab, index) => [tab.id, [`pty-${index}`]]))
    })

    const plans = buildTerminalTabRetirementPlans(
      state,
      tabs.map((tab) => tab.id)
    )

    expect(plans).toHaveLength(100)
    expect(terminalStoreScans).toBe(1)
    expect(unifiedStoreScans).toBe(1)
  })
})
