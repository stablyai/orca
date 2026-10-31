import type { TerminalSemanticResident } from '../../components/terminal-pane/terminal-semantic-residents'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import { createHarness } from './runtime-client-ipc-bridge-harness-fixture'
import { TerminalSnapshotConsumption } from '../../../../shared/terminal-snapshot-consumption'
import { getDefaultSettings } from '../../../../shared/constants'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TerminalSnapshotState } from '../../../../shared/terminal-snapshot-state'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import {
  getTerminalSemanticResident,
  _resetTerminalSideEffectFactConsumersForTest
} from '../../components/terminal-pane/terminal-side-effect-facts-handler'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import {
  beginWorktreeLineageRefresh,
  isRemoteWorktreeLineageFresh
} from '../../store/slices/worktrees/metadata/worktree-lineage-readiness'

const initialState = useAppStore.getState()

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  _resetTerminalSideEffectFactConsumersForTest()
  useAppStore.setState(initialState, true)
  replaceRuntimeEnvironmentRevisions(initialState.runtimeEnvironments)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function measuredConsumption(resident: TerminalSemanticResident): TerminalSnapshotConsumption {
  const value: unknown = Object.getOwnPropertyDescriptor(resident, 'consumption')?.value
  if (!(value instanceof TerminalSnapshotConsumption)) {
    throw new Error('Expected actual resident cursor')
  }
  return value
}

function measuredRevision(cursor: TerminalSnapshotConsumption): number | undefined {
  const value: unknown = Object.getOwnPropertyDescriptor(cursor, 'previous')?.value
  if (value === null) {
    return undefined
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('revision' in value) ||
    typeof value.revision !== 'number'
  ) {
    throw new Error('Expected actual installed snapshot revision')
  }
  return value.revision
}

it('does no Linear read dispatch or cache publication after cleanup while setup is pending', async () => {
  const h = createHarness()
  let publications = 0
  const stopCounting = useAppStore.subscribe((state, previous) => {
    if (state.linearIssueCache !== previous.linearIssueCache) {
      publications += 1
    }
  })
  try {
    h.start()()
    for (let index = 0; index < 100; index += 1) {
      h.emit(0)
    }
    expect(h.getIssue).not.toHaveBeenCalled()
    expect(publications).toBe(0)
  } finally {
    stopCounting()
    await h.finish()
  }
  expect(h.ipc.removeListener).toHaveBeenCalledOnce()
})

it('does not navigate for an unaddressed activation from an older remote host', async () => {
  const h = createHarness()
  try {
    h.start()
    h.emit(0, false, { type: 'activateWorktree', repoId: 'remote-repo', worktreeId: 'remote-wt' })
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve()
    }
    expect(h.activateNotifiedWorktree).not.toHaveBeenCalled()
    h.emit(0, false, { type: 'worktreesChanged', repoId: 'remote-repo' })
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve()
    }
    expect(h.enqueue).toHaveBeenCalledWith({
      repoId: 'remote-repo',
      executionHostId: 'runtime:host-a'
    })
  } finally {
    await h.finish()
  }
})

it.each([true, false, undefined, 'true', 1, null])(
  'forwards only an explicit order-only host hint (%s)',
  async (sortOrderOnly) => {
    const h = createHarness()
    try {
      h.start()
      h.emit(0, false, { type: 'worktreesChanged', repoId: 'remote-repo', sortOrderOnly })
      for (let index = 0; index < 10; index += 1) {
        await Promise.resolve()
      }
      expect(h.enqueue).toHaveBeenCalledWith({
        repoId: 'remote-repo',
        executionHostId: 'runtime:host-a',
        ...(sortOrderOnly === true ? { sortOrderOnly: true } : {})
      })
    } finally {
      await h.finish()
    }
  }
)

it.each([
  { sortOrderOnly: true, valid: true, known: true, kept: true },
  { sortOrderOnly: undefined, valid: true, known: true, kept: false },
  { sortOrderOnly: true, valid: false, known: true, kept: false },
  // An unknown repo refetches so a slow discovery cannot replay older values last.
  { sortOrderOnly: true, valid: true, known: false, kept: false }
])('forwards published order values only on a valid order-only event (%o)', async (input) => {
  const h = createHarness()
  const sortOrders = input.valid
    ? [{ worktreeId: 'remote-repo::/a', sortOrder: 5 }]
    : [{ worktreeId: 'remote-repo::/a' }]
  if (input.known) {
    useAppStore.setState({
      repos: [
        {
          id: 'remote-repo',
          path: '/remote/repo',
          displayName: 'Remote repo',
          badgeColor: 'blue',
          addedAt: 1,
          executionHostId: 'runtime:host-a'
        }
      ]
    })
  }
  try {
    h.start()
    h.emit(0, false, {
      type: 'worktreesChanged',
      repoId: 'remote-repo',
      sortOrderOnly: input.sortOrderOnly,
      sortOrders
    })
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve()
    }
    expect(h.enqueue).toHaveBeenCalledWith({
      repoId: 'remote-repo',
      executionHostId: 'runtime:host-a',
      ...(input.sortOrderOnly === true ? { sortOrderOnly: true } : {}),
      ...(input.kept ? { sortOrders } : {})
    })
  } finally {
    await h.finish()
  }
})

it('invalidates lineage before unknown-repository discovery can block a structural event', async () => {
  const h = createHarness()
  const repos = Promise.withResolvers<never[]>()
  h.fetchRuntimeEnvironmentRepos.mockImplementation(() => repos.promise)
  try {
    h.start()
    beginWorktreeLineageRefresh(useAppStore.getState, {
      kind: 'environment',
      environmentId: 'host-a'
    })(true)
    expect(isRemoteWorktreeLineageFresh(useAppStore.getState, 'host-a')).toBe(true)
    h.emit(0, false, { type: 'worktreesChanged', repoId: 'unknown-repo' })
    expect(h.enqueue).not.toHaveBeenCalled()
    expect(isRemoteWorktreeLineageFresh(useAppStore.getState, 'host-a')).toBe(false)
  } finally {
    repos.resolve([])
    await h.finish()
  }
})

it('invalidates hydrated lineage as soon as a project change is queued', async () => {
  const h = createHarness()
  try {
    h.start()
    beginWorktreeLineageRefresh(useAppStore.getState, {
      kind: 'environment',
      environmentId: 'host-a'
    })(true)
    h.emit(0, false, { type: 'reposChanged' })
    expect(isRemoteWorktreeLineageFresh(useAppStore.getState, 'host-a')).toBe(false)
    expect(h.fetchRuntimeEnvironmentRepos).not.toHaveBeenCalled()
  } finally {
    await h.finish()
  }
})

it.each(['caller', 'host'] as const)(
  'ignores remote activation addressed to %s',
  async (navigation) => {
    const h = createHarness()
    try {
      h.start()
      h.emit(0, false, {
        type: 'activateWorktree',
        repoId: 'remote-repo',
        worktreeId: 'remote-wt',
        navigation
      })
      for (let index = 0; index < 10; index += 1) {
        await Promise.resolve()
      }
      expect(h.activateNotifiedWorktree).not.toHaveBeenCalled()
    } finally {
      await h.finish()
    }
  }
)

it.each(['clients', 'all'] as const)(
  'honors explicit %s activation on the publishing host',
  async (navigation) => {
    const h = createHarness()
    try {
      h.start()
      const event: RuntimeClientEvent = {
        type: 'activateWorktree',
        repoId: 'remote-repo',
        worktreeId: 'remote-wt',
        navigation
      }
      h.emit(0, false, event)
      for (let index = 0; index < 10; index += 1) {
        await Promise.resolve()
      }
      expect(h.activateNotifiedWorktree).toHaveBeenCalledWith(event, {
        allowRuntimeEnvironment: true,
        executionHostId: 'runtime:host-a',
        isCurrent: expect.any(Function)
      })
    } finally {
      await h.finish()
    }
  }
)

it('does not mistake a local repo with the same id for the publishing remote repo', async () => {
  const h = createHarness()
  useAppStore.setState({
    repos: [
      {
        id: 'same-repo',
        path: '/local/repo',
        displayName: 'Local repo',
        badgeColor: 'blue',
        addedAt: 1
      }
    ]
  })
  try {
    h.start()
    h.emit(0, false, {
      type: 'activateWorktree',
      repoId: 'same-repo',
      worktreeId: 'same-wt',
      navigation: 'clients'
    })
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve()
    }
    expect(h.fetchRuntimeEnvironmentRepos).toHaveBeenCalledWith('host-a')
    expect(h.activateNotifiedWorktree).toHaveBeenCalledWith(expect.anything(), {
      allowRuntimeEnvironment: true,
      executionHostId: 'runtime:host-a',
      isCurrent: expect.any(Function)
    })
  } finally {
    await h.finish()
  }
})

it.each(['cleanup', 're-pair'] as const)(
  'cancels an accepted activation after %s during repository discovery',
  async (change) => {
    const h = createHarness()
    const repos = Promise.withResolvers<never[]>()
    h.fetchRuntimeEnvironmentRepos.mockImplementation(() => repos.promise)
    try {
      const stop = h.start()
      h.emit(0, false, {
        type: 'activateWorktree',
        repoId: 'remote-repo',
        worktreeId: 'remote-wt',
        navigation: 'clients'
      })
      expect(h.fetchRuntimeEnvironmentRepos).toHaveBeenCalledWith('host-a')
      if (change === 'cleanup') {
        stop()
      } else {
        replaceRuntimeEnvironmentRevisions([{ id: 'host-a', createdAt: 1, pairingRevision: 2 }])
      }
      repos.resolve([])
      for (let index = 0; index < 10; index += 1) {
        await Promise.resolve()
      }
      expect(h.activateNotifiedWorktree).not.toHaveBeenCalled()
    } finally {
      repos.resolve([])
      await h.finish()
    }
  }
)

it('does no replay recovery or resubscription after cleanup', async () => {
  const h = createHarness()
  try {
    h.start()()
    h.emit(0, true)
    expect(h.refreshStatus).not.toHaveBeenCalled()
    expect(h.pending).toHaveLength(1)
    expect(h.getIssue).not.toHaveBeenCalled()
  } finally {
    await h.finish()
  }
})

it('accepts a fresh bridge early frame while rejecting the previous bridge frame', async () => {
  const h = createHarness()
  try {
    h.start()()
    h.start()
    h.emit(0)
    h.emit(1)
    expect(h.getIssue).toHaveBeenCalledOnce()
    expect(h.getIssue).toHaveBeenCalledWith({ id: 'ISSUE-1', workspaceId: 'workspace-a' })
  } finally {
    await h.finish()
  }
  expect(h.ipc.removeListener).toHaveBeenCalledOnce()
})

it("lists a profile created on the host once the host announces it, without touching other hosts' lists", async () => {
  const h = createHarness()
  const madeByCli = {
    id: 'made-by-cli',
    scope: 'isolated' as const,
    partition: 'persist:orca-browser-session-made-by-cli',
    label: 'Made by CLI',
    source: null
  }
  const status = createCompatibleRuntimeStatusResponse()
  vi.mocked(window.api.runtimeEnvironments.call).mockImplementation(async ({ method }) =>
    method === 'status.get'
      ? status
      : {
          id: 'r',
          ok: true,
          result: { profiles: [madeByCli] },
          _meta: { runtimeId: 'remote-runtime' }
        }
  )
  useAppStore.setState({ browserSessionProfilesByHostId: { local: [] } })
  try {
    h.start()
    h.emit(0, false, { type: 'browserProfilesChanged' })
    await vi.waitFor(() =>
      expect(useAppStore.getState().browserSessionProfilesByHostId['runtime:host-a']).toEqual([
        madeByCli
      ])
    )
    expect(useAppStore.getState().browserSessionProfilesByHostId.local).toEqual([])
  } finally {
    await h.finish()
  }
})

it('installs a restarted runtime baseline before live effects on the same physical execution', async () => {
  const h = createHarness()
  const markTerminalBell = vi.fn()
  useAppStore.setState({ markTerminalBell })
  const source = new TerminalSnapshotState()
  const batch = (runtimeId: string) => ({
    ptyId: 'physical',
    paneKey: 'tab:leaf',
    tabId: 'tab',
    worktreeId: 'remote-wt',
    seq: 1,
    facts: [],
    terminalState: { runtimeId, incarnationId: 'incarnation', snapshot: source.snapshot() }
  })
  try {
    h.start()
    h.emit(0, false, {
      type: 'ready',
      subscriptionId: 'sub-0',
      snapshot: { terminalSideEffects: [batch('old-runtime')] }
    })
    const resident = getTerminalSemanticResident(toRemoteRuntimePtyId('physical', 'host-a'))
    expect(resident).toBeDefined()
    const policy = resident?.policy
    source.record({ kind: 'bell' }, Date.now())
    h.emit(0, false, { type: 'terminalSideEffects', batch: batch('foreign-runtime') })
    expect(markTerminalBell).not.toHaveBeenCalled()
    h.emit(0, true, {
      type: 'ready',
      subscriptionId: 'sub-0',
      snapshot: { terminalSideEffects: [batch('new-runtime')] }
    })
    expect(markTerminalBell).not.toHaveBeenCalled()
    expect(h.pending).toHaveLength(2)
    h.emit(1, false, {
      type: 'ready',
      subscriptionId: 'sub-1',
      snapshot: { terminalSideEffects: [batch('new-runtime')] }
    })
    expect(getTerminalSemanticResident(toRemoteRuntimePtyId('physical', 'host-a'))).toBe(resident)
    expect(resident?.policy).toBe(policy)
    expect(resident?.identity.runtimeId).toBe('new-runtime')
    source.record({ kind: 'bell' }, Date.now() + 1)
    h.emit(1, false, { type: 'terminalSideEffects', batch: batch('new-runtime') })
    expect(markTerminalBell).toHaveBeenCalledTimes(1)
    source.record({ kind: 'bell' }, Date.now() + 2)
    h.emit(1, false, { type: 'terminalSideEffects', batch: batch('old-runtime') })
    expect(markTerminalBell).toHaveBeenCalledTimes(1)
  } finally {
    await h.finish()
  }
})

it('R2-C3 follows actual empty-ready rollback and upgrade with stale or missing status on the same execution', async () => {
  const h = createHarness()
  const markTerminalBell = vi.fn()
  useAppStore.setState({
    markTerminalBell,
    fetchHostWorkspaceStatuses: vi.fn(async () => {}),
    settings: {
      ...getDefaultSettings('/home/test'),
      ...useAppStore.getState().settings,
      activeRuntimeEnvironmentId: 'host-a'
    }
  })
  const source = new TerminalSnapshotState()
  const ptyId = toRemoteRuntimePtyId('physical', 'host-a')
  const batch = () => ({
    ptyId: 'physical',
    paneKey: 'tab:leaf',
    tabId: 'tab',
    worktreeId: 'remote-wt',
    seq: source.state.revision,
    facts: [],
    terminalState: {
      runtimeId: 'new-runtime',
      incarnationId: 'incarnation',
      snapshot: source.snapshot()
    }
  })
  const legacy = () => ({
    type: 'terminalSideEffects' as const,
    batch: {
      ptyId: 'physical',
      paneKey: 'tab:leaf',
      tabId: 'tab',
      worktreeId: 'remote-wt',
      seq: 1,
      facts: [{ kind: 'bell' as const }]
    }
  })
  try {
    h.start()
    h.emit(0, false, {
      type: 'ready',
      subscriptionId: 'sub-0',
      snapshot: { terminalSideEffects: [batch()] }
    })
    const resident = getTerminalSemanticResident(ptyId)
    expect(resident).toBeDefined()
    const policy = resident?.policy
    const cursor = resident && measuredConsumption(resident)
    // Store capability deliberately remains stale-capable throughout rollback.
    h.emit(0, true, { type: 'ready', subscriptionId: 'sub-0', snapshot: {} })
    expect(h.pending).toHaveLength(2)
    h.emit(1, false, { type: 'ready', subscriptionId: 'sub-1', snapshot: {} })
    h.emit(0, false, legacy())
    expect(markTerminalBell).not.toHaveBeenCalled()
    h.emit(1, false, legacy())
    expect(markTerminalBell).toHaveBeenCalledOnce()
    // Missing separately refreshed status must not suppress a current actual ready.
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/home/test'),
        ...useAppStore.getState().settings,
        activeRuntimeEnvironmentId: 'host-a'
      },
      runtimeStatusByEnvironmentId: new Map()
    })
    expect(h.pending).toHaveLength(4)
    h.emit(2, false, { type: 'ready', subscriptionId: 'sub-2', snapshot: {} })
    h.emit(2, false, legacy())
    expect(markTerminalBell).toHaveBeenCalledOnce()
    h.emit(3, false, {
      type: 'ready',
      subscriptionId: 'sub-3',
      snapshot: { terminalSideEffects: [] }
    })
    h.emit(3, false, legacy())
    expect(markTerminalBell).toHaveBeenCalledOnce()
    expect(getTerminalSemanticResident(ptyId)).toBe(resident)
    expect(measuredRevision(cursor!)).toBe(0)
    source.record({ kind: 'bell' }, Date.now())
    h.emit(3, false, { type: 'terminalSideEffects', batch: batch() })
    expect(measuredRevision(cursor!)).toBe(1)
    expect(markTerminalBell).toHaveBeenCalledTimes(2)
    h.emit(1, false, legacy())
    expect(markTerminalBell).toHaveBeenCalledTimes(2)
    expect(getTerminalSemanticResident(ptyId)).toBe(resident)
    expect(resident?.policy).toBe(policy)
    expect(resident && measuredConsumption(resident)).toBe(cursor)
  } finally {
    await h.finish()
  }
})
