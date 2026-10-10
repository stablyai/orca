import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorktreeIdentity } from '../../../shared/worktree/identity'
import type { Repo } from '../../../shared/repo-types'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { makeWorktree } from '../components/automations/automations-page-fixtures'
import { useAppStore } from '../store'
import { repoWithFetchedOwner } from '../store/repos/owner-routing'
import { withRepoHostOwnership } from '../store/slices/worktrees/listing/worktree-host-ownership'
import { worktreeSelectionOwnerForRow } from '../lib/worktree-selection-owner'
import { activateWebRuntimeSessionWorktree } from './web-runtime-worktree-activation'
import {
  refreshWebRuntimeSessionTabsSnapshot,
  scheduleRuntimeWorktreeRecoveryRefresh
} from './web-runtime-session-snapshot'
import { admitsWebRuntimeSessionWorktreeSnapshot } from './web-runtime-session-worktree-owner'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import { isSessionTabsListAllResult } from './web-session-tabs-sync/tracking'
import { installActiveSessionTabsSubscription } from './web-session-tabs-sync/active-session-subscription'
import type { WindowVisibilitySubscriptionSpec } from './window-visibility-subscription-parking'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

vi.mock('./window-visibility-subscription-parking', () => ({
  installWindowVisibilitySubscriptionParking: (
    specs: readonly WindowVisibilitySubscriptionSpec[]
  ) => {
    const handles = specs.map((spec) => spec.subscribe(() => true, { visibilityGeneration: 0 }))
    return () => {
      for (const handle of handles) {
        void handle.then((value) => value.unsubscribe())
      }
    }
  }
}))

const id = 'repo-owner::/repo/checkout'
const environmentId = 'publisher-session-owner'
const initial = useAppStore.getState()

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useAppStore.setState(initial, true)
})

function fixture(duplicated = true) {
  const raws = duplicated ? ['a', 'b'] : ['b']
  const entries = raws.map((raw) => {
    const repo: Repo = {
      id: 'repo-owner',
      path: '/repo',
      displayName: 'Repo',
      badgeColor: 'blue',
      addedAt: 1,
      executionHostId: `ssh:${raw}`,
      connectionId: raw
    }
    const identity = createWorktreeIdentity({
      worktreeId: id,
      executionHostId: `ssh:${raw}`,
      instanceId: randomUUID()
    })
    return {
      repo: repoWithFetchedOwner(repo, { kind: 'environment', environmentId }),
      row: withRepoHostOwnership(
        makeWorktree({
          id,
          repoId: repo.id,
          path: '/repo/checkout',
          hostId: `ssh:${raw}`,
          instanceId: identity.instanceId,
          identity
        }),
        `runtime:${environmentId}`
      )
    }
  })
  const selected = entries.at(-1)!
  const repos = entries.map((entry) => entry.repo)
  const owner = worktreeSelectionOwnerForRow(selected.row, repos)
  if (!owner) {
    throw new Error('Missing captured owner')
  }
  useAppStore.setState({
    repos,
    worktreesByRepo: { 'repo-owner': entries.map((entry) => entry.row) },
    detectedWorktreesByRepo: {},
    activeWorktreeId: id,
    activeWorkspaceOwner: owner,
    activeWorkspaceExecutionHostId: owner.executionHostId,
    tabsByWorktree: { [id]: [] },
    unifiedTabsByWorktree: { [id]: [] }
  })
  const snapshot: RuntimeMobileSessionTabsResult = {
    worktree: id,
    publicationEpoch: 'owner-test',
    snapshotVersion: 1,
    worktreeIdentity: selected.row.identity,
    tabs: [],
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null
  }
  return { owner, snapshot, entries, selected }
}

describe('captured runtime session owner at client transport boundaries', () => {
  it('the active stream addresses B exactly and ignores a frame after B is retired', async () => {
    const f = fixture()
    let response: ((value: RuntimeRpcResponse<unknown>) => void) | undefined
    const subscribe = vi.fn(
      async (
        _args: Parameters<typeof window.api.runtimeEnvironments.subscribe>[0],
        handlers: Parameters<typeof window.api.runtimeEnvironments.subscribe>[1]
      ) => {
        response = handlers.onResponse
        return { unsubscribe: vi.fn() }
      }
    )
    vi.stubGlobal('window', { api: { runtimeEnvironments: { subscribe } } })
    const receipt = vi.fn()
    const dispose = installActiveSessionTabsSubscription({
      activeWorktreeId: id,
      activeWorkspaceOwner: f.owner,
      activeWorktreeRuntimeEnvironmentId: environmentId,
      activeWorktreeRuntimeConnectionGeneration: 0,
      activeWorktreeRuntimePairingRevision: undefined,
      workspaceSessionReady: true,
      visibilitySnapshotReceipt: { current: receipt },
      visibilitySnapshotApply: { current: () => true },
      visibilitySnapshotAccepted: { current: () => {} }
    })
    expect(subscribe).toHaveBeenCalledOnce()
    expect(subscribe.mock.calls[0][0]).toMatchObject({
      method: 'session.tabs.subscribe',
      params: { worktree: toRuntimeWorktreeSelector(id, f.selected.row.identity) }
    })
    useAppStore.setState({ worktreesByRepo: {} })
    const before = useAppStore.getState()
    response?.({
      id: 'stale-stream',
      ok: true,
      _meta: { runtimeId: 'session-owner-runtime' },
      result: { ...f.snapshot, type: 'snapshot' }
    })
    await Promise.resolve()
    expect(receipt).not.toHaveBeenCalled()
    expect(useAppStore.getState()).toBe(before)
    dispose?.()
  })
  it('an older selector parser rejects once without retrying the bare ID', async () => {
    const f = fixture()
    const call = vi.fn(async (_args: { method: string; params?: unknown }) => ({
      id: 'old-parser',
      ok: false,
      error: { code: 'selector_not_found', message: 'selector_not_found' }
    }))
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      activateWebRuntimeSessionWorktree({ worktreeId: id, environmentId, owner: f.owner })
    ).resolves.toBe(false)
    expect(call).toHaveBeenCalledOnce()
    expect(call.mock.calls[0][0]).toMatchObject({
      method: 'worktree.activate',
      params: { worktree: toRuntimeWorktreeSelector(id, f.selected.row.identity) }
    })
  })

  it('an older host missing result identity refuses twins before a Store write', async () => {
    const f = fixture()
    const { worktreeIdentity: _identity, ...legacy } = f.snapshot
    const call = vi.fn(async () => ({ id: 'old-result', ok: true, result: legacy }))
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
    const before = useAppStore.getState()
    await expect(
      refreshWebRuntimeSessionTabsSnapshot(environmentId, id, {
        owner: f.owner,
        errorMode: 'throw'
      })
    ).rejects.toThrow('selector_not_found')
    expect(useAppStore.getState()).toBe(before)
    expect(call).toHaveBeenCalledOnce()
  })

  it('an older host missing result identity remains compatible with a unique current owner', async () => {
    const f = fixture(false)
    const { worktreeIdentity: _identity, ...legacy } = f.snapshot
    expect(
      admitsWebRuntimeSessionWorktreeSnapshot(
        useAppStore.getState(),
        environmentId,
        legacy,
        f.owner
      )
    ).toBe(true)
  })

  it('activation with an older unlabeled inventory refuses before mirroring or recovery', async () => {
    const f = fixture()
    const { worktreeIdentity: _identity, ...legacy } = f.snapshot
    const call = vi.fn(async (args: { method: string; params?: unknown }) => ({
      id: args.method,
      ok: true,
      result: args.method === 'worktree.activate' ? { activated: true } : legacy
    }))
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = useAppStore.getState()
    await expect(
      activateWebRuntimeSessionWorktree({ worktreeId: id, environmentId, owner: f.owner })
    ).resolves.toBe(false)
    expect(useAppStore.getState()).toBe(before)
    expect(call).toHaveBeenCalledTimes(2)
    for (const [args] of call.mock.calls) {
      expect(args.params).toMatchObject({
        worktree: toRuntimeWorktreeSelector(id, f.selected.row.identity)
      })
    }
  })

  it('an unlabeled bulk frame refuses genuinely duplicate visible owner rows', () => {
    const f = fixture(false)
    const { worktreeIdentity: _identity, ...legacy } = f.snapshot
    useAppStore.setState({
      activeWorktreeId: null,
      activeWorkspaceOwner: null,
      worktreesByRepo: { 'repo-owner': [f.selected.row, { ...f.selected.row }] }
    })
    expect(
      admitsWebRuntimeSessionWorktreeSnapshot(useAppStore.getState(), environmentId, legacy)
    ).toBe(false)
  })

  it('a supplied incomplete owner refuses before transport rather than downgrading', async () => {
    const f = fixture()
    const { instanceId: _instanceId, ...partial } = f.owner
    const call = vi.fn()
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
    await expect(
      activateWebRuntimeSessionWorktree({ worktreeId: id, environmentId, owner: partial })
    ).resolves.toBe(false)
    expect(call).not.toHaveBeenCalled()
  })

  it('bounded recovery retains the exact selector and stops after owner retirement', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const call = vi.fn(async (_args: { method: string; params?: unknown }) => ({
      id: 'recovery',
      ok: true,
      result: f.snapshot
    }))
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
    scheduleRuntimeWorktreeRecoveryRefresh(environmentId, id, undefined, f.owner)
    await vi.advanceTimersByTimeAsync(250)
    expect(call).toHaveBeenCalledOnce()
    expect(call.mock.calls[0][0]).toMatchObject({
      method: 'session.tabs.list',
      params: { worktree: toRuntimeWorktreeSelector(id, f.selected.row.identity) }
    })
    const replacement = { ...f.selected.row, instanceId: randomUUID() }
    replacement.identity = createWorktreeIdentity({
      worktreeId: id,
      executionHostId: f.owner.executionHostId,
      instanceId: replacement.instanceId
    })
    useAppStore.setState({
      worktreesByRepo: {
        'repo-owner': [...f.entries.slice(0, -1).map((entry) => entry.row), replacement]
      }
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(call).toHaveBeenCalledOnce()
  })

  it('old client projection retains its known fields when optional identity is published', () => {
    const f = fixture(false)
    const wire = JSON.parse(JSON.stringify(f.snapshot))
    expect(isSessionTabsListAllResult({ snapshots: [wire], authoritative: true })).toBe(true)
    const legacyRead = {
      worktree: wire.worktree,
      tabs: wire.tabs,
      snapshotVersion: wire.snapshotVersion
    }
    expect(legacyRead).toEqual({ worktree: id, tabs: [], snapshotVersion: 1 })
  })
})
