import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

const mockKill = vi.fn().mockResolvedValue(undefined)
const mockRuntimeCall = vi.fn().mockResolvedValue({
  id: 'rpc-1',
  ok: true,
  result: {},
  _meta: { runtimeId: 'local-runtime' }
})

vi.stubGlobal('window', {
  api: {
    pty: { kill: mockKill },
    runtime: { call: mockRuntimeCall },
    runtimeEnvironments: { call: vi.fn() }
  }
})

import { buildTerminalTabRetirementPlan } from './terminal-tab-retirement'
import { createTestStore, makeTab, makeWorktree, seedStore } from './store-test-helpers'

type RetirementState = Parameters<typeof buildTerminalTabRetirementPlan>[0]

const OWNED = 'remote:env-b@@handle-1'

function terminalTab(ptyId: string | null): TerminalTab {
  return {
    id: 'tab-1',
    worktreeId: 'wt-1',
    ptyId,
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function unifiedTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'tab-1',
    entityId: 'tab-1',
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType: 'terminal',
    executionHostId: 'runtime:env-b',
    projectHostSetupId: 'setup-b',
    label: 'Terminal 1',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function planFor(
  ptyIds: string[],
  tab: Tab = unifiedTab()
): ReturnType<typeof buildTerminalTabRetirementPlan> {
  const state: RetirementState = {
    worktreesByRepo: { repo: [{ id: 'wt-1', repoId: 'repo', hostId: 'local' }] },
    tabsByWorktree: { 'wt-1': [terminalTab(ptyIds[0] ?? null)] },
    unifiedTabsByWorktree: { 'wt-1': [tab] },
    ptyIdsByTabId: { 'tab-1': ptyIds },
    terminalLayoutsByTabId: {},
    lastKnownRelayPtyIdByTabId: {},
    deferredSshSessionIdsByTabId: {},
    pendingReconnectPtyIdByTabId: {}
  }
  return buildTerminalTabRetirementPlan(state, 'tab-1')
}

describe('host-stamped terminal retirement planning', () => {
  it('closes an owned PTY on its stamped runtime', () => {
    const plan = planFor([OWNED])
    expect(plan.runtimeTerminals).toEqual([
      { ptyId: OWNED, environmentId: 'env-b', handle: 'handle-1' }
    ])
    expect(plan.localOrSshPtyIds).toEqual([])
    expect(plan.unroutablePtyIds).toEqual([])
  })

  it('never routes an ownerless, foreign, blank or local PTY to a provider', () => {
    const stray = ['remote:handle-2', 'remote:env-c@@handle-3', 'remote:env-b@@', 'pty-local']
    const plan = planFor([OWNED, ...stray])
    expect(plan.runtimeTerminals.map((terminal) => terminal.ptyId)).toEqual([OWNED])
    expect(plan.localOrSshPtyIds).toEqual([])
    expect(plan.unroutablePtyIds).toEqual(stray)
  })

  const UNROUTABLE_STAMPS: [string, Partial<Tab>][] = [
    ['a blank setup stamp', { projectHostSetupId: '' }],
    ['a non-runtime host', { executionHostId: 'local' }],
    ['a malformed host', { executionHostId: 'runtime:' }],
    ['a missing host', { executionHostId: undefined }]
  ]

  it.each(UNROUTABLE_STAMPS)('treats every PTY as unroutable for %s', (_label, overrides) => {
    const plan = planFor([OWNED, 'pty-local'], unifiedTab(overrides))
    expect(plan.runtimeTerminals).toEqual([])
    expect(plan.localOrSshPtyIds).toEqual([])
    expect(plan.unroutablePtyIds).toEqual([OWNED, 'pty-local'])
  })

  it('keeps legacy planning for a tab without a setup stamp', () => {
    const plan = planFor(['pty-local'], unifiedTab({ projectHostSetupId: undefined }))
    expect(plan.localOrSshPtyIds).toEqual(['pty-local'])
  })
})

describe('host-stamped terminal close at the store boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends no raw remote handle to the local runtime and kills nothing locally', async () => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: 'wt-1', repoId: 'repo1', path: '/repo/wt-1' })]
      },
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1', ptyId: 'remote:handle-2' })]
      },
      unifiedTabsByWorktree: { 'wt-1': [unifiedTab()] },
      ptyIdsByTabId: { 'tab-1': ['remote:handle-2', 'pty-local'] }
    })

    store.getState().closeTab('tab-1')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(store.getState().tabsByWorktree['wt-1']).toEqual([])
    expect(mockRuntimeCall).not.toHaveBeenCalled()
    expect(mockKill).not.toHaveBeenCalled()
  })
})
