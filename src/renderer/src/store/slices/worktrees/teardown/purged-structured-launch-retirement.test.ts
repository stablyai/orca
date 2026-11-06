// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  hostWorktreeTarget,
  type HostWorktreeTarget
} from '../../../../../../shared/worktree/host-qualified-identity'
import {
  getStructuredLaunchStateBySessionId,
  hasStructuredAgentSessionLaunchCancellationTombstone,
  resetStructuredAgentLaunchRegistryForTests
} from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import {
  batchStructuredAgentLaunchRecordWrites,
  readStructuredAgentLaunchRecords,
  resetStructuredAgentLaunchPersistenceForTests
} from '@/lib/agent-session/launch/structured-agent-session-launch-persistence'
import { restorePersistedStructuredLaunchState } from '@/lib/agent-session/launch/structured-agent-session-launch-reload'
import type { WorktreePurgeTarget } from '../../worktree-helpers'
import { settleStructuredLaunchesForFolderCatalog } from '@/lib/agent-session/launch/structured-agent-session-launch-restore'
import {
  addTargetLaunchRemoval,
  cancelStructuredLaunchesForWorktrees
} from './purged-structured-launch-retirement'
import { makeWorktree } from '../../store-test-helpers'
import type * as HostOwnershipModule from '../listing/worktree-host-ownership'
import type * as RetirementModule from './purged-structured-launch-retirement'

/** Work at the purge's own boundaries: listing matches attributing publishers, and each keyed
 *  lookup, host check or scan of the membership the whole removal hands its launch retirement. */
const work = vi.hoisted(() => {
  const counts = { listingMatches: 0, lookups: 0, hostChecks: 0, scans: 0 }
  class CountedHosts<T> extends Set<T> {
    override has(value: T): boolean {
      counts.hostChecks++
      return super.has(value)
    }
  }
  class CountedRemoval<K, V> extends Map<K, V> {
    override get(key: K): V | undefined {
      counts.lookups++
      return super.get(key)
    }
    override forEach(...args: Parameters<Map<K, V>['forEach']>): void {
      counts.scans++
      super.forEach(...args)
    }
    override entries(): MapIterator<[K, V]> {
      counts.scans++
      return super.entries()
    }
    override keys(): MapIterator<K> {
      counts.scans++
      return super.keys()
    }
    override values(): MapIterator<V> {
      counts.scans++
      return super.values()
    }
    override [Symbol.iterator](): MapIterator<[K, V]> {
      counts.scans++
      return super.entries()
    }
  }
  const counted = <K, V extends { hosts: Set<string> }>(removal: Map<K, V>) =>
    new CountedRemoval(
      [...removal].map(([id, entry]) => [id, { ...entry, hosts: new CountedHosts(entry.hosts) }])
    ) as unknown as Map<K, V>
  return { counts, counted }
})
vi.mock('../listing/worktree-host-ownership', async (original) => {
  const actual = await original<typeof HostOwnershipModule>()
  return {
    ...actual,
    worktreeMatchesHost: (...args: Parameters<typeof actual.worktreeMatchesHost>) => {
      work.counts.listingMatches++
      return actual.worktreeMatchesHost(...args)
    }
  }
})
vi.mock('./purged-structured-launch-retirement', async (original) => {
  const actual = await original<typeof RetirementModule>()
  return {
    ...actual,
    retirePurgedLaunches: (
      retirement: Parameters<typeof actual.retirePurgedLaunches>[0]
    ): Set<string> =>
      actual.retirePurgedLaunches({ ...retirement, removal: work.counted(retirement.removal) })
  }
})

const LAUNCHES = 'orca:structuredAgentLaunches:v1'
const TOMBSTONES = 'orca:structuredAgentLaunchCancelledSessions:v1'
const ENV_1 = 'runtime:env-1' as ExecutionHostId
const ENV_2 = 'runtime:env-2' as ExecutionHostId
const initialState = useAppStore.getState()
const dropping = (targets: WorktreePurgeTarget[]) => addTargetLaunchRemoval(new Map(), targets)

/** A saved host launch whose chat never showed, as this window writes it. */
const row = (sessionId: string, executionHostId: ExecutionHostId, worktreeId: string) => ({
  sessionId,
  executionHostId,
  agent: 'codex',
  lifecycle: 'failed',
  clientOperationId: `op-${sessionId}`,
  payloadFingerprint: 'fingerprint',
  expectedRuntimeFence: null,
  hostLaunchOperationId: `host-op-${sessionId}`,
  surfaceAddress: { worktreeId, precedingTabIds: [] }
})
type Row = ReturnType<typeof row>

/** After a reload: these rows saved, nothing loaded, no launch held in memory. */
function reloadWith(rows: Row[]): void {
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
  localStorage.removeItem(TOMBSTONES)
  localStorage.setItem(LAUNCHES, JSON.stringify(rows))
  // No listing or session ever loaded these workspaces here.
  useAppStore.setState({ worktreesByRepo: {}, restoredRuntimeHostIdByWorkspaceSessionKey: {} })
}

type Saves = { mutations: string[]; launchRows: number; tombstoneRows: number }

/** Every save or removal of either journal `run` makes, in order, and the entries each holds. */
function countSaves(run: () => void): Saves {
  const set = vi.spyOn(localStorage, 'setItem')
  const remove = vi.spyOn(localStorage, 'removeItem')
  try {
    run()
    const calls = [
      ...set.mock.calls.map((call, index) => ({ call, at: set.mock.invocationCallOrder[index]! })),
      ...remove.mock.calls.map((call, index) => ({
        call,
        at: remove.mock.invocationCallOrder[index]!
      }))
    ]
      .filter(({ call: [key] }) => key === LAUNCHES || key === TOMBSTONES)
      .sort((a, b) => a.at - b.at)
    const rows = (key: string) =>
      calls
        .filter(({ call }) => call[0] === key && call.length > 1)
        .reduce((sum, { call }) => sum + (JSON.parse(call[1] as string) as unknown[]).length, 0)
    return {
      mutations: calls.map(({ call }) => call[0] as string),
      launchRows: rows(LAUNCHES),
      tombstoneRows: rows(TOMBSTONES)
    }
  } finally {
    set.mockRestore()
    remove.mockRestore()
  }
}

beforeEach(() => {
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
})

afterEach(() => {
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
  localStorage.removeItem(LAUNCHES)
  localStorage.removeItem(TOMBSTONES)
  useAppStore.setState(initialState, true)
})

describe('removing a paired host with many saved launches', () => {
  const rowsOn = (host: ExecutionHostId, count: number) =>
    Array.from({ length: count }, (_, index) =>
      row(`${host}-${count}-${index}`, host, `repo-1::/never-loaded-${index}`)
    )

  it.each([3, 30])('saves each journal once, tombstones first (%i launches)', (count) => {
    reloadWith([...rowsOn(ENV_1, count), ...rowsOn(ENV_2, count)])
    const saves = countSaves(() => useAppStore.getState().purgeStaleRuntimeHostState(['env-1']))

    expect(saves.mutations).toEqual([TOMBSTONES, LAUNCHES])
    // Each journal written once, holding what it keeps: linear in the rows, not their square.
    expect(saves.tombstoneRows).toBe(count)
    expect(saves.launchRows).toBe(count)
    // Only the removed host's launches end; the other host's stay saved for it.
    expect(readStructuredAgentLaunchRecords().map((record) => record.executionHostId)).toEqual(
      Array.from({ length: count }, () => ENV_2)
    )
    for (const { sessionId } of rowsOn(ENV_1, count)) {
      expect(hasStructuredAgentSessionLaunchCancellationTombstone('', sessionId)).toBe(true)
    }
    // Removing it again finds nothing left to end.
    expect(
      countSaves(() => useAppStore.getState().purgeStaleRuntimeHostState(['env-1'])).mutations
    ).toEqual([])
  })

  it.each([3, 30])(
    "ends one removal of %i hosts' copies of shared workspaces in one save of each journal",
    (count) => {
      const ids = Array.from({ length: count }, (_, index) => `repo-1::/shared-${count}-${index}`)
      const gone = ids.map((_, index) => `runtime:gone-${index}` as ExecutionHostId)
      const only = 'repo-1::/only'
      reloadWith([
        ...ids.flatMap((id, index) => [
          row(`gone-${index}`, gone[index]!, id),
          row(`kept-${index}`, ENV_2, id)
        ]),
        row('only', ENV_1, only)
      ])
      // One removed host's launch is also held live again after a Retry.
      expect(restorePersistedStructuredLaunchState(ids[0]!, 'gone-0')).toBeDefined()
      // Each workspace published by its removed host and by env-2, which stays.
      useAppStore.setState({
        worktreesByRepo: {
          'repo-1': ids.flatMap((id, index) => [
            makeWorktree({ id, repoId: 'repo-1', hostId: gone[index], path: `/shared-${index}` }),
            makeWorktree({ id, repoId: 'repo-1', hostId: ENV_2, path: `/shared-${index}` })
          ])
        }
      })
      const purge = () =>
        useAppStore
          .getState()
          .purgeWorktreeTerminalState([
            ...ids.map((id, index) => hostWorktreeTarget({ id, hostId: gone[index]! })),
            only
          ])
      const saves = countSaves(purge)

      // env-2's copies keep their launches; every removed copy's ends, live or saved only.
      expect(readStructuredAgentLaunchRecords().map(({ sessionId }) => sessionId)).toEqual(
        ids.map((_, index) => `kept-${index}`)
      )
      expect(getStructuredLaunchStateBySessionId('gone-0')).toBeUndefined()
      for (const sessionId of ['only', ...ids.map((_, index) => `gone-${index}`)]) {
        expect(hasStructuredAgentSessionLaunchCancellationTombstone('', sessionId)).toBe(true)
      }
      expect(saves.mutations).toEqual([TOMBSTONES, LAUNCHES])
      expect(saves.tombstoneRows).toBe(count + 1)
      expect(saves.launchRows).toBe(count)
      // The same removal again ends and saves nothing.
      expect(countSaves(purge).mutations).toEqual([])
    }
  )

  it('ends every launch in memory at once when saving fails, and never blocks the removal', () => {
    reloadWith(rowsOn(ENV_1, 3))
    const full = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(() => useAppStore.getState().purgeStaleRuntimeHostState(['env-1'])).not.toThrow()
    } finally {
      full.mockRestore()
      warn.mockRestore()
    }
    expect(readStructuredAgentLaunchRecords()).toEqual([])
    for (const { sessionId } of rowsOn(ENV_1, 3)) {
      expect(hasStructuredAgentSessionLaunchCancellationTombstone('', sessionId)).toBe(true)
    }
  })

  it('saves what a retirement changed even when it throws partway', () => {
    reloadWith(rowsOn(ENV_1, 3))
    const saves = countSaves(() =>
      expect(() =>
        batchStructuredAgentLaunchRecordWrites(() => {
          cancelStructuredLaunchesForWorktrees(dropping([{ id: 'repo-1::/never-loaded-0' }]))
          throw new Error('interrupted')
        })
      ).toThrow('interrupted')
    )
    expect(saves.mutations).toEqual([TOMBSTONES, LAUNCHES])
    expect(saves.launchRows).toBe(2)
  })
})

describe('ending launches for dropped workspaces', () => {
  /** Purge targets whose ids count each read. */
  function countedTargets(ids: string[], hostId: ExecutionHostId) {
    const reads = { count: 0 }
    const targets: WorktreePurgeTarget[] = ids.map((id) => ({
      get id() {
        reads.count++
        return id
      },
      hostId
    }))
    return { targets, reads }
  }
  const workspaces = (count: number, name: string) =>
    Array.from({ length: count }, (_, index) => `repo-1::/${name}-${count}-${index}`)

  it.each([3, 30])(
    'reads each dropped workspace once, whether or not it ends anything (%i)',
    (count) => {
      // Launches on one host; another host drops the same number of unrelated workspaces.
      const kept = workspaces(count, 'kept')
      reloadWith(kept.map((id, index) => row(`kept-${count}-${index}`, ENV_2, id)))
      const unrelated = countedTargets(workspaces(count, 'gone'), ENV_1)
      const saves = countSaves(() =>
        expect(cancelStructuredLaunchesForWorktrees(dropping(unrelated.targets))).toEqual(new Set())
      )
      expect(unrelated.reads.count).toBe(count)
      expect(saves.mutations).toEqual([])

      // The same workspaces dropped by their own host, half of them also held live after a
      // Retry: each launch ends exactly once and each journal is saved once.
      const sessions = kept.map((_, index) => `kept-${count}-${index}`)
      for (const [index, sessionId] of sessions.entries()) {
        if (index % 2 === 0) {
          expect(restorePersistedStructuredLaunchState(kept[index]!, sessionId)).toBeDefined()
        }
      }
      const matched = countedTargets(kept, ENV_2)
      const ended = countSaves(() =>
        expect(cancelStructuredLaunchesForWorktrees(dropping(matched.targets))).toEqual(
          new Set(sessions)
        )
      )
      expect(matched.reads.count).toBe(count)
      expect(ended.mutations).toEqual([TOMBSTONES, LAUNCHES])
      expect(ended.tombstoneRows).toBe(count)
      expect(readStructuredAgentLaunchRecords()).toEqual([])
      expect(sessions.some((sessionId) => getStructuredLaunchStateBySessionId(sessionId))).toBe(
        false
      )
    }
  )

  it('ends a host launch only for its own host, or a drop that names no host', () => {
    reloadWith([row('same-workspace', ENV_2, 'repo-1::/shared')])
    // Another host dropping the same workspace id ends nothing.
    expect(
      cancelStructuredLaunchesForWorktrees(dropping([{ id: 'repo-1::/shared', hostId: ENV_1 }]))
    ).toEqual(new Set())
    // A drop that names no host ends it, as does one with no host evidence at all.
    expect(
      cancelStructuredLaunchesForWorktrees(
        dropping([{ id: 'repo-1::/shared', hostId: ENV_1 }, { id: 'repo-1::/shared' }])
      )
    ).toEqual(new Set(['same-workspace']))
    reloadWith([row('no-evidence', ENV_2, 'repo-1::/shared')])
    expect(cancelStructuredLaunchesForWorktrees(dropping([{ id: 'repo-1::/shared' }]))).toEqual(
      new Set(['no-evidence'])
    )
  })

  it.each([3, 30])(
    "ends a host's saved-only launches in folders its catalog no longer lists in one save (%i)",
    (count) => {
      const folders = Array.from({ length: count }, (_, index) => `folder:gone-${count}-${index}`)
      const ours = folders.map((id, index) => row(`ours-${count}-${index}`, ENV_1, id))
      // Another host's launches under the very same folder ids.
      const twins = folders.map((id, index) => row(`twin-${count}-${index}`, ENV_2, id))
      reloadWith([...ours, ...twins, row('listed', ENV_1, 'folder:kept')])
      // Half held live again after a Retry; the rest saved only, their folders never loaded.
      for (const [index, { sessionId }] of ours.entries()) {
        if (index % 2 === 0) {
          expect(restorePersistedStructuredLaunchState(folders[index]!, sessionId)).toBeDefined()
        }
      }
      const catalog = () =>
        settleStructuredLaunchesForFolderCatalog(
          ENV_1,
          new Map([[ENV_1, new Set(['folder:kept'])]])
        )
      const saves = countSaves(catalog)
      // Only the saved-only ones end; a launch live here ends by its own paths.
      const live = ours.filter((_, index) => index % 2 === 0).map(({ sessionId }) => sessionId)
      expect(saves.mutations).toEqual([TOMBSTONES, LAUNCHES])
      expect(saves.tombstoneRows).toBe(count - live.length)
      expect(readStructuredAgentLaunchRecords().map(({ sessionId }) => sessionId)).toEqual([
        ...live,
        ...twins.map(({ sessionId }) => sessionId),
        'listed'
      ])
      expect(live.every((sessionId) => getStructuredLaunchStateBySessionId(sessionId))).toBe(true)
      // The same catalog again ends and saves nothing.
      expect(countSaves(catalog).mutations).toEqual([])
    }
  )
})

describe("one removal of many hosts' copies of the same workspace id", () => {
  const SAME = 'repo-1::/same-path'
  const ALIAS = 'repo-1::/through-proxy'
  const EXCLUSIVE = 'repo-1::/exclusive'
  const SHARED_PROXY = 'repo-1::/shared-proxy'
  const SSH = 'ssh:box' as ExecutionHostId
  const PROXY = 'runtime:proxy' as ExecutionHostId

  /** Targets whose own fields count each read. */
  function countedTarget(id: string, hostId?: ExecutionHostId) {
    // Branded as a host target as the public purge takes it; without a host it reads as a raw id.
    const target = { reads: 0 } as HostWorktreeTarget & { reads: number }
    Object.defineProperty(target, 'id', {
      get: () => (target.reads++, id),
      enumerable: true
    })
    Object.defineProperty(target, 'hostId', {
      get: () => (target.reads++, hostId),
      enumerable: true
    })
    return target
  }

  it.each([3, 30])('classifies each target, publisher and launch once at %i hosts', (count) => {
    const gone = Array.from(
      { length: count },
      (_, index) => `runtime:gone-${index}` as ExecutionHostId
    )
    const rows = [
      ...gone.map((host, index) => row(`gone-${index}`, host, SAME)),
      row('kept', ENV_2, SAME),
      // An unstamped row no single repo owner claims stays a survivor, launch and all.
      row('legacy-local', 'local' as ExecutionHostId, SAME),
      // An SSH copy reached through a paired runtime: either spelling of its host is the purged copy.
      row('alias-ssh', SSH, ALIAS),
      row('alias-proxy', PROXY, ALIAS),
      row('alias-kept', ENV_2, ALIAS),
      // The runtime an SSH copy was reached through still publishes the id, so it is no alias.
      row('proxied-ssh', 'ssh:box-2' as ExecutionHostId, SHARED_PROXY),
      row('proxy-kept', 'runtime:proxy-2' as ExecutionHostId, SHARED_PROXY),
      // A workspace only env-1 publishes goes whole; a host launch elsewhere waits on its own host.
      row('exclusive-own', ENV_1, EXCLUSIVE),
      row('exclusive-other', ENV_2, EXCLUSIVE),
      row('only', ENV_1, 'repo-1::/only')
    ]
    reloadWith(rows)
    expect(restorePersistedStructuredLaunchState(SAME, 'gone-0')).toBeDefined()
    const publishers = [
      ...[...gone, ENV_2].map((hostId) =>
        makeWorktree({ id: SAME, repoId: 'repo-1', hostId, path: '/same-path' })
      ),
      makeWorktree({ id: SAME, repoId: 'repo-1', path: '/same-path' }),
      makeWorktree({
        id: ALIAS,
        repoId: 'repo-1',
        hostId: SSH,
        runtimeOwnerEnvironmentId: 'proxy'
      }),
      makeWorktree({ id: ALIAS, repoId: 'repo-1', hostId: ENV_2 }),
      makeWorktree({
        id: SHARED_PROXY,
        repoId: 'repo-1',
        hostId: 'ssh:box-2' as ExecutionHostId,
        runtimeOwnerEnvironmentId: 'proxy-2'
      }),
      makeWorktree({
        id: SHARED_PROXY,
        repoId: 'repo-1',
        hostId: 'runtime:proxy-2' as ExecutionHostId
      }),
      makeWorktree({ id: EXCLUSIVE, repoId: 'repo-1', hostId: ENV_1 })
    ]
    useAppStore.setState({ worktreesByRepo: { 'repo-1': publishers } })
    const targets = [
      ...gone.map((hostId) => countedTarget(SAME, hostId)),
      countedTarget(ALIAS, PROXY),
      countedTarget(SHARED_PROXY, 'ssh:box-2' as ExecutionHostId),
      countedTarget(EXCLUSIVE, ENV_1),
      countedTarget('repo-1::/only')
    ]
    Object.assign(work.counts, { listingMatches: 0, lookups: 0, hostChecks: 0, scans: 0 })
    const purge = () => useAppStore.getState().purgeWorktreeTerminalState(targets)
    const saves = countSaves(purge)

    expect(readStructuredAgentLaunchRecords().map(({ sessionId }) => sessionId)).toEqual([
      'kept',
      'legacy-local',
      'alias-kept',
      'proxy-kept',
      'exclusive-other'
    ])
    expect(getStructuredLaunchStateBySessionId('gone-0')).toBeUndefined()
    for (const sessionId of [
      ...gone.map((_, index) => `gone-${index}`),
      'alias-ssh',
      'alias-proxy',
      'proxied-ssh',
      'exclusive-own',
      'only'
    ]) {
      expect(hasStructuredAgentSessionLaunchCancellationTombstone('', sessionId)).toBe(true)
    }
    expect(saves.mutations).toEqual([TOMBSTONES, LAUNCHES])
    expect(saves.tombstoneRows).toBe(count + 5)
    expect(saves.launchRows).toBe(5)

    // Target normalization: fixed linear passes, field reads per target: slice filter 1; edit
    // flush twin collection 3 and closed-file split 3; purge twin collection 3, full/twin split 2,
    // full ids 1, launch membership 2, visit recency 3, host keys 2. At most 20, whatever N.
    for (const target of targets) {
      expect(target.reads).toBeLessThanOrEqual(20)
    }
    // Publisher attribution: a row names its host by runtime owner, stamp or, unstamped, as local
    // or the repo's only owner, so each listing derivation (the edit flush and the purge) tries
    // at most 2 purged hosts per publisher row: at most 2 x 2 x P listing matches.
    expect(work.counts.listingMatches).toBeLessThanOrEqual(4 * publishers.length)
    // Launch membership: one keyed lookup per live launch and per saved row still standing, each
    // with at most one host check, and no scan of the membership: the live launch's own row was
    // already ended by the live pass.
    expect(work.counts.lookups).toBe(1 + rows.length - 1)
    expect(work.counts.hostChecks).toBeLessThanOrEqual(work.counts.lookups)
    expect(work.counts.scans).toBe(0)

    // The same removal again ends and saves nothing.
    expect(countSaves(purge).mutations).toEqual([])
  })
})
