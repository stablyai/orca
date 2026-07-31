import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabGroup, TerminalTab } from '../../../shared/types'
import {
  ensureTerminalTabProjection,
  hasTerminalTabProjectionInvariant
} from '@/store/slices/terminal-tab-projection'
import {
  repairLiveTerminalTabProjections,
  type TerminalTabProjectionRepairStore
} from './terminal-tab-projection-repair'

type RepairState = ReturnType<TerminalTabProjectionRepairStore['getState']>

function makeBackingTab(worktreeId: string, id: string, ptyId: string | null): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId,
    title: `Terminal ${id}`,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    pendingActivationSpawn: true
  }
}

function createRepairStore(overrides: Partial<RepairState> = {}): {
  store: TerminalTabProjectionRepairStore
  getState: () => RepairState
  setState: (patch: Partial<RepairState>) => void
} {
  let state: RepairState
  const ensure = (worktreeId: string, tabId: string, targetGroupId?: string) => {
    const outcome = ensureTerminalTabProjection(
      state,
      worktreeId,
      tabId,
      targetGroupId,
      () => `group-${tabId}`
    )
    state = { ...state, ...outcome.patch, ensureTerminalTabProjection: ensure }
    return outcome.result
  }
  state = {
    workspaceSessionReady: true,
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    layoutByWorktree: {},
    activeTabIdByWorktree: {},
    ensureTerminalTabProjection: ensure,
    ...overrides
  }
  return {
    store: { getState: () => state },
    getState: () => state,
    setState: (patch) => {
      state = { ...state, ...patch, ensureTerminalTabProjection: ensure }
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('repairLiveTerminalTabProjections', () => {
  it('repairs every provider-confirmed live background tab without filtering by active workspace', async () => {
    const first = makeBackingTab('workspace-b', 'tab-b', 'pty-b')
    const second = makeBackingTab('folder:workspace-a', 'tab-a', null)
    const floating = makeBackingTab('__floating-terminal__', 'tab-floating', 'pty-floating')
    const availableSsh = makeBackingTab(
      'ssh:available:host:/repo',
      'tab-available-ssh',
      'pty-available-ssh'
    )
    const foregroundGroups = [
      {
        id: 'foreground-group',
        worktreeId: 'foreground',
        activeTabId: null,
        tabOrder: []
      }
    ]
    const harness = createRepairStore({
      tabsByWorktree: {
        'workspace-b': [first],
        'folder:workspace-a': [second],
        '__floating-terminal__': [floating],
        'ssh:available:host:/repo': [availableSsh]
      },
      ptyIdsByTabId: {
        'tab-b': ['pty-b'],
        'tab-a': [],
        'tab-floating': ['pty-floating'],
        'tab-available-ssh': ['pty-available-ssh']
      },
      terminalLayoutsByTabId: {
        'tab-a': {
          root: { type: 'leaf', leafId: 'leaf-a' },
          activeLeafId: 'leaf-a',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-a': 'pty-a-layout' }
        }
      },
      groupsByWorktree: { foreground: foregroundGroups },
      activeGroupIdByWorktree: { foreground: 'foreground-group' },
      layoutByWorktree: {
        foreground: { type: 'leaf', groupId: 'foreground-group' }
      }
    })
    const hasPty = vi.fn(async () => true)

    const summary = await repairLiveTerminalTabProjections({ store: harness.store, hasPty })
    const state = harness.getState()

    expect(summary).toMatchObject({
      ready: true,
      examinedTabCount: 4,
      candidateTabCount: 4,
      probedPtyCount: 4,
      livePtyCount: 4,
      confirmedLiveTabCount: 4,
      repairedTabCount: 4,
      skippedTabCount: 0
    })
    expect(hasTerminalTabProjectionInvariant(state, 'workspace-b', 'tab-b')).toBe(true)
    expect(hasTerminalTabProjectionInvariant(state, 'folder:workspace-a', 'tab-a')).toBe(true)
    expect(hasTerminalTabProjectionInvariant(state, '__floating-terminal__', 'tab-floating')).toBe(
      true
    )
    expect(
      hasTerminalTabProjectionInvariant(state, 'ssh:available:host:/repo', 'tab-available-ssh')
    ).toBe(true)
    await expect(
      repairLiveTerminalTabProjections({ store: harness.store, hasPty })
    ).resolves.toMatchObject({
      examinedTabCount: 4,
      candidateTabCount: 0,
      probedPtyCount: 0,
      repairedTabCount: 0,
      skippedTabCount: 0
    })
    expect(hasPty).toHaveBeenCalledTimes(4)
    expect(state.activeGroupIdByWorktree.foreground).toBe('foreground-group')
    expect(state.groupsByWorktree.foreground).toBe(foregroundGroups)
  })

  it('deduplicates candidate ids and rechecks the binding after an async liveness probe', async () => {
    const tab = makeBackingTab('workspace', 'tab-1', 'pty-shared')
    let resolveProbe!: (value: boolean) => void
    const hasPty = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProbe = resolve
        })
    )
    const harness = createRepairStore({
      tabsByWorktree: { workspace: [tab] },
      ptyIdsByTabId: { 'tab-1': ['pty-shared', 'pty-shared'] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: 'leaf' },
          activeLeafId: 'leaf',
          expandedLeafId: null,
          ptyIdsByLeafId: { leaf: 'pty-shared' }
        }
      }
    })

    const pending = repairLiveTerminalTabProjections({ store: harness.store, hasPty })
    await Promise.resolve()
    expect(hasPty).toHaveBeenCalledTimes(1)
    harness.setState({ tabsByWorktree: { workspace: [] } })
    resolveProbe(true)

    await expect(pending).resolves.toMatchObject({
      probedPtyCount: 1,
      livePtyCount: 1,
      confirmedLiveTabCount: 0,
      repairedTabCount: 0,
      skippedTabCount: 1
    })
  })
  it('skips a backing tab rebound while its prior PTY probe is in flight', async () => {
    const tab = makeBackingTab('workspace', 'tab-1', 'pty-old')
    let resolveProbe!: (value: boolean) => void
    const hasPty = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProbe = resolve
        })
    )
    const harness = createRepairStore({
      tabsByWorktree: { workspace: [tab] },
      ptyIdsByTabId: { 'tab-1': ['pty-old'] }
    })

    const pending = repairLiveTerminalTabProjections({ store: harness.store, hasPty })
    await Promise.resolve()
    harness.setState({
      tabsByWorktree: {
        workspace: [{ ...tab, ptyId: 'pty-new' }]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-new'] }
    })
    resolveProbe(true)

    await expect(pending).resolves.toMatchObject({
      probedPtyCount: 1,
      livePtyCount: 1,
      confirmedLiveTabCount: 0,
      repairedTabCount: 0,
      skippedTabCount: 1
    })
    expect(harness.getState().unifiedTabsByWorktree.workspace).toBeUndefined()
  })

  it('fails closed for false, unknown, rejected, and timed-out probes', async () => {
    vi.useFakeTimers()
    const tabs = ['false', 'unknown', 'rejected', 'timeout', 'live'].map((suffix, index) => ({
      ...makeBackingTab('workspace', `tab-${suffix}`, `pty-${suffix}`),
      sortOrder: index
    }))
    const harness = createRepairStore({
      tabsByWorktree: { workspace: tabs },
      ptyIdsByTabId: Object.fromEntries(tabs.map((tab) => [tab.id, [tab.ptyId as string]]))
    })
    const hasPty = vi.fn((ptyId: string): Promise<boolean | null> => {
      if (ptyId === 'pty-false') {
        return Promise.resolve(false)
      }
      if (ptyId === 'pty-unknown') {
        return Promise.resolve(null)
      }
      if (ptyId === 'pty-rejected') {
        return Promise.reject(new Error('provider unavailable'))
      }
      if (ptyId === 'pty-live') {
        return Promise.resolve(true)
      }
      return new Promise(() => {})
    })

    const pending = repairLiveTerminalTabProjections({
      store: harness.store,
      hasPty,
      probeTimeoutMs: 20,
      deadlineMs: 50
    })
    await vi.advanceTimersByTimeAsync(25)

    await expect(pending).resolves.toMatchObject({
      candidateTabCount: 5,
      probedPtyCount: 5,
      livePtyCount: 1,
      deadPtyCount: 1,
      unknownPtyCount: 1,
      probeFailureCount: 1,
      timedOutPtyCount: 1,
      firstProbeError: 'provider unavailable',
      confirmedLiveTabCount: 1,
      repairedTabCount: 1,
      skippedTabCount: 4
    })
    expect(hasTerminalTabProjectionInvariant(harness.getState(), 'workspace', 'tab-live')).toBe(
      true
    )
  })

  it('reports deadline-suppressed probes without calling the provider', async () => {
    const tab = makeBackingTab('workspace', 'tab-1', 'pty-1')
    const harness = createRepairStore({
      tabsByWorktree: { workspace: [tab] },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })
    const hasPty = vi.fn(async () => true)

    await expect(
      repairLiveTerminalTabProjections({
        store: harness.store,
        hasPty,
        deadlineMs: 0
      })
    ).resolves.toMatchObject({
      candidateTabCount: 1,
      probedPtyCount: 0,
      deadlineSuppressedPtyCount: 1,
      repairedTabCount: 0,
      skippedTabCount: 1
    })
    expect(hasPty).not.toHaveBeenCalled()
  })
  it('does not probe or mutate when startup is already aborted', async () => {
    const tab = makeBackingTab('workspace', 'tab-1', 'pty-1')
    const harness = createRepairStore({
      tabsByWorktree: { workspace: [tab] },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })
    const hasPty = vi.fn(async () => true)
    const controller = new AbortController()
    controller.abort()

    await expect(
      repairLiveTerminalTabProjections({
        store: harness.store,
        hasPty,
        signal: controller.signal
      })
    ).resolves.toMatchObject({
      candidateTabCount: 1,
      probedPtyCount: 0,
      repairedTabCount: 0,
      skippedTabCount: 1
    })
    expect(hasPty).not.toHaveBeenCalled()
    expect(harness.getState().unifiedTabsByWorktree.workspace).toBeUndefined()
  })

  it('does not mutate after an in-flight live probe is aborted', async () => {
    const tab = makeBackingTab('workspace', 'tab-1', 'pty-1')
    let resolveProbe!: (value: boolean) => void
    const hasPty = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveProbe = resolve
        })
    )
    const ensureProjection = vi.fn((_worktreeId: string, tabId: string) => ({
      status: 'skipped' as const,
      tabId,
      reason: 'missing-backing-tab' as const
    }))
    const harness = createRepairStore({
      tabsByWorktree: { workspace: [tab] },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      ensureTerminalTabProjection: ensureProjection
    })
    const controller = new AbortController()

    const pending = repairLiveTerminalTabProjections({
      store: harness.store,
      hasPty,
      signal: controller.signal
    })
    await Promise.resolve()
    controller.abort()
    resolveProbe(true)

    await expect(pending).resolves.toMatchObject({
      probedPtyCount: 1,
      livePtyCount: 1,
      confirmedLiveTabCount: 0,
      repairedTabCount: 0,
      skippedTabCount: 1
    })
    expect(ensureProjection).not.toHaveBeenCalled()
    expect(harness.getState().unifiedTabsByWorktree.workspace).toBeUndefined()
  })

  it('applies pooled live-probe results in candidate order despite reversed completion', async () => {
    const first = makeBackingTab('workspace', 'tab-1', 'pty-1')
    const second = { ...makeBackingTab('workspace', 'tab-2', 'pty-2'), sortOrder: 1 }
    const third = { ...makeBackingTab('workspace', 'tab-3', 'pty-3'), sortOrder: 2 }
    const primaryGroup: TabGroup = {
      id: 'group-primary',
      worktreeId: 'workspace',
      activeTabId: 'editor-1',
      tabOrder: ['editor-1']
    }
    const siblingGroup: TabGroup = {
      id: 'group-sibling',
      worktreeId: 'workspace',
      activeTabId: 'editor-2',
      tabOrder: ['editor-2']
    }
    const primaryEditor: Tab = {
      id: 'editor-1',
      entityId: '/tmp/one.ts',
      groupId: primaryGroup.id,
      worktreeId: 'workspace',
      contentType: 'editor',
      label: 'one.ts',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    const siblingEditor: Tab = {
      ...primaryEditor,
      id: 'editor-2',
      entityId: '/tmp/two.ts',
      groupId: siblingGroup.id,
      label: 'two.ts',
      sortOrder: 1,
      createdAt: 2
    }
    const harness = createRepairStore({
      tabsByWorktree: { workspace: [first, second, third] },
      ptyIdsByTabId: {
        'tab-1': ['pty-1'],
        'tab-2': ['pty-2'],
        'tab-3': ['pty-3']
      },
      unifiedTabsByWorktree: { workspace: [primaryEditor, siblingEditor] },
      groupsByWorktree: { workspace: [primaryGroup, siblingGroup] },
      activeGroupIdByWorktree: { workspace: primaryGroup.id },
      layoutByWorktree: {
        workspace: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', groupId: primaryGroup.id },
          second: { type: 'leaf', groupId: siblingGroup.id }
        }
      }
    })

    // Why: with three candidates and concurrency two, pty-2 and pty-3 settle before
    // pty-1. Projection order must still follow the collected candidate order.
    let resolveFirstProbe!: (value: boolean) => void
    const firstProbe = new Promise<boolean>((resolve) => {
      resolveFirstProbe = resolve
    })
    let resolveThirdProbeStarted!: () => void
    const thirdProbeStarted = new Promise<void>((resolve) => {
      resolveThirdProbeStarted = resolve
    })
    const startedPtyIds: string[] = []
    const hasPty = vi.fn((ptyId: string) => {
      startedPtyIds.push(ptyId)
      if (ptyId === 'pty-3') {
        resolveThirdProbeStarted()
      }
      return ptyId === 'pty-1' ? firstProbe : Promise.resolve(true)
    })
    const pending = repairLiveTerminalTabProjections({
      store: harness.store,
      hasPty,
      concurrency: 2,
      probeTimeoutMs: 30_000,
      deadlineMs: 30_000
    })
    expect(startedPtyIds).toEqual(['pty-1', 'pty-2'])
    await thirdProbeStarted
    expect(startedPtyIds).toEqual(['pty-1', 'pty-2', 'pty-3'])
    resolveFirstProbe(true)
    const summary = await pending
    const state = harness.getState()
    const groups = state.groupsByWorktree.workspace

    expect(summary).toMatchObject({
      examinedTabCount: 3,
      candidateTabCount: 3,
      livePtyCount: 3,
      confirmedLiveTabCount: 3,
      repairedTabCount: 3,
      unchangedTabCount: 0,
      skippedTabCount: 0
    })
    expect(groups).toHaveLength(2)
    expect(groups[0].tabOrder).toEqual(['editor-1', 'tab-1', 'tab-2', 'tab-3'])
    expect(hasTerminalTabProjectionInvariant(state, 'workspace', 'tab-1')).toBe(true)
    expect(hasTerminalTabProjectionInvariant(state, 'workspace', 'tab-2')).toBe(true)
    expect(hasTerminalTabProjectionInvariant(state, 'workspace', 'tab-3')).toBe(true)
  })

  it('retains the exact structural reason when a confirmed-live projection is skipped', async () => {
    const tab = makeBackingTab('workspace', 'tab-1', 'pty-1')
    const ensureProjection = vi.fn((_worktreeId: string, tabId: string) => ({
      status: 'skipped' as const,
      tabId,
      reason: 'duplicate-backing-tab' as const
    }))
    const harness = createRepairStore({
      tabsByWorktree: { workspace: [tab] },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      ensureTerminalTabProjection: ensureProjection
    })

    const summary = await repairLiveTerminalTabProjections({
      store: harness.store,
      hasPty: vi.fn(async () => true)
    })

    expect(summary).toMatchObject({
      candidateTabCount: 1,
      confirmedLiveTabCount: 1,
      repairedTabCount: 0,
      unchangedTabCount: 0,
      skippedTabCount: 1,
      projectionSkipReasons: { 'duplicate-backing-tab': 1 }
    })
    expect(summary.repairedTabCount + summary.unchangedTabCount + summary.skippedTabCount).toBe(
      summary.candidateTabCount
    )
  })
  it('does not probe before the workspace session is ready', async () => {
    const tab = makeBackingTab('workspace', 'tab-1', 'pty-1')
    const harness = createRepairStore({
      workspaceSessionReady: false,
      tabsByWorktree: { workspace: [tab] }
    })
    const hasPty = vi.fn(async () => true)

    await expect(
      repairLiveTerminalTabProjections({ store: harness.store, hasPty })
    ).resolves.toMatchObject({ ready: false, candidateTabCount: 1, skippedTabCount: 1 })
    expect(hasPty).not.toHaveBeenCalled()
  })
})
