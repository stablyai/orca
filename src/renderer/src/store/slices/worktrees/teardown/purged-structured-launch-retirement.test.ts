// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
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
import { cancelStructuredLaunchesForWorktrees } from './purged-structured-launch-retirement'

const LAUNCHES = 'orca:structuredAgentLaunches:v1'
const TOMBSTONES = 'orca:structuredAgentLaunchCancelledSessions:v1'
const ENV_1 = 'runtime:env-1' as ExecutionHostId
const ENV_2 = 'runtime:env-2' as ExecutionHostId
const initialState = useAppStore.getState()

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
          cancelStructuredLaunchesForWorktrees(new Set(['repo-1::/never-loaded-0']))
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
        expect(
          cancelStructuredLaunchesForWorktrees(
            new Set(workspaces(count, 'gone')),
            undefined,
            unrelated.targets
          )
        ).toEqual(new Set())
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
        expect(
          cancelStructuredLaunchesForWorktrees(new Set(kept), undefined, matched.targets)
        ).toEqual(new Set(sessions))
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
      cancelStructuredLaunchesForWorktrees(new Set(['repo-1::/shared']), undefined, [
        { id: 'repo-1::/shared', hostId: ENV_1 }
      ])
    ).toEqual(new Set())
    // A drop that names no host ends it, as does one with no host evidence at all.
    expect(
      cancelStructuredLaunchesForWorktrees(new Set(['repo-1::/shared']), undefined, [
        { id: 'repo-1::/shared', hostId: ENV_1 },
        { id: 'repo-1::/shared' }
      ])
    ).toEqual(new Set(['same-workspace']))
    reloadWith([row('no-evidence', ENV_2, 'repo-1::/shared')])
    expect(cancelStructuredLaunchesForWorktrees(new Set(['repo-1::/shared']))).toEqual(
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
