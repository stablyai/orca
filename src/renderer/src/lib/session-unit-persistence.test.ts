import { describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import { discoverSessionSources } from './test-support/session-source-discovery'
import { SessionUnitProjection } from './session-unit-projection'
import { SessionUnitWriter } from './session-unit-writer'
import { createTerminalTabOwnerIndex } from '../store/slices/terminal-tab-owner-index'
import { buildWorkspaceSessionPatch } from './workspace-session-patch'
import { SESSION_RELEVANT_FIELDS } from './workspace-session'
import {
  applySessionMapDeltas,
  type SessionMapDeltas,
  type SessionMapField
} from '../../../shared/session-change-set'
import type { AppState } from '../store/types'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { editSessionSource, unwrapSessionSourceWrite } from '../store/session-source-edits'
import { makeOpenFile } from '../store/slices/store-session-test-harness'
import type { WorkspaceSessionPatch } from '../../../shared/workspace-session-state-types'

function fixture(): AppState {
  const state = useAppStore.getState()
  const tab = (id: string, worktreeId: string) => ({
    id,
    worktreeId,
    ptyId: null,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  })
  return {
    ...state,
    workspaceSessionReady: true,
    hydrationSucceeded: true,
    tabsByWorktree: { 'repo::/a': [tab('a', 'repo::/a')], 'other::/b': [tab('b', 'other::/b')] },
    terminalLayoutsByTabId: {},
    repos: [],
    worktreesByRepo: {},
    openFiles: [],
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    remoteBrowserPageHandlesByPageId: {}
  }
}

describe('keyed session persistence', () => {
  it('projects draft-only edits from retained ordered occurrences without reading openFiles', () => {
    const file = makeOpenFile({ id: 'shared', worktreeId: 'repo::/a', isDirty: true })
    const twin = { ...file, worktreeId: 'other::/b' }
    const before = { ...fixture(), openFiles: [file, file, twin], editorDrafts: {} }
    const projection = new SessionUnitProjection(before)
    const write = editSessionSource(before).set('editorDrafts', 'shared', 'new draft').finish()
    const native = { ...before, editorDrafts: { shared: 'new draft' } }
    expect(unwrapSessionSourceWrite(write).partial.editorDrafts).toEqual(native.editorDrafts)
    const expected = buildWorkspaceSessionPatch(native, ['editorDrafts'])
    const openFiles = new Proxy(native.openFiles, {
      get: () => {
        throw new Error('unrelated file traversal')
      }
    })
    const update = projection.update(
      { ...native, openFiles },
      unwrapSessionSourceWrite(write).receipt!
    )
    expect(update.full).toBe(false)
    expect(update.patch.openFilesByWorktree).toEqual(expected.openFilesByWorktree)
    expect(update.patch.openFilesByWorktree?.['repo::/a']).toHaveLength(2)
  })
  it('routes duplicate tab owners like the native owner index through reorder, removal and reinsert', () => {
    let state = fixture()
    const a = [{ ...state.tabsByWorktree['repo::/a'][0], id: 'duplicate' }]
    const b = [{ ...state.tabsByWorktree['other::/b'][0], id: 'duplicate' }]
    state = {
      ...state,
      tabsByWorktree: { 'repo::/a': a, 'other::/b': b },
      terminalLayoutsByTabId: {
        duplicate: { root: null, activeLeafId: null, expandedLeafId: null }
      }
    }
    const projection = new SessionUnitProjection(state)
    const oracle = createTerminalTabOwnerIndex()
    expect(projection.full(state).terminalOwners?.get('duplicate')).toBe(
      oracle.getOwner(state.tabsByWorktree, 'duplicate')
    )
    const sequence: AppState['tabsByWorktree'][] = [
      { 'repo::/a': a, 'other::/b': [...b, b[0]] },
      { 'other::/b': b, 'repo::/a': a },
      { 'other::/b': b },
      { 'other::/b': b, 'repo::/a': a }
    ]
    for (const buckets of sequence) {
      const next = { ...state, tabsByWorktree: buckets }
      const update = projection.update(next, discoverSessionSources(state, next))
      expect(update.terminalOwners?.get('duplicate')).toBe(oracle.getOwner(buckets, 'duplicate'))
      state = next
    }
  })
  it('projects a named owner without reading another owner, retaining frozen prior rows', () => {
    const prior = fixture()
    const projection = new SessionUnitProjection(prior)
    const old = prior.tabsByWorktree['repo::/a']
    Object.freeze(old[0])
    Object.freeze(old)
    Object.freeze(prior.tabsByWorktree)
    const untouched = prior.tabsByWorktree['other::/b']
    Object.defineProperty(untouched, Symbol.iterator, {
      value: () => {
        throw new Error('unrelated content read')
      }
    })
    const next = {
      ...prior,
      tabsByWorktree: {
        ...prior.tabsByWorktree,
        'repo::/a': [{ ...old[0], customTitle: 'renamed' }]
      }
    }
    const update = projection.update(next, discoverSessionSources(prior, next))
    expect(update.full).toBe(false)
    expect(Object.keys(update.patch.tabsByWorktree ?? {})).toEqual(['repo::/a'])
    expect(update.patch.tabsByWorktree?.['repo::/a'][0].customTitle).toBe('renamed')
    expect(old[0].customTitle).toBe(null)
    expect(next.tabsByWorktree['other::/b']).toBe(untouched)
  })

  it('retires only applied baselines after mixed partition outcomes', async () => {
    const state = fixture()
    const patch = vi.fn(async (_patch: WorkspaceSessionPatch) => ({
      applied: true,
      partitionGeneration: 'one'
    }))
    const writer = new SessionUnitWriter({
      patch,
      getWithGeneration: async () => ({
        session: getDefaultWorkspaceSession(),
        partitionGeneration: 'read'
      })
    })
    const projection = new SessionUnitProjection(state)
    await writer.write(projection.full(state), state)
    patch.mockClear()
    const next = {
      ...state,
      tabsByWorktree: {
        ...state.tabsByWorktree,
        'repo::/a': [{ ...state.tabsByWorktree['repo::/a'][0], customTitle: 'next' }]
      }
    }
    await writer.write(projection.update(next, discoverSessionSources(state, next)), next)
    expect(patch).toHaveBeenCalledTimes(1)
    expect(Object.keys(patch.mock.calls[0][0].mapDeltas?.tabsByWorktree?.set ?? {})).toEqual([
      'repo::/a'
    ])
    expect(JSON.stringify(patch.mock.calls[0][0])).not.toContain('other::/b')
  })

  it('uses a fresh generation-fenced read for full compatibility retry', async () => {
    const state = fixture()
    const patch = vi
      .fn()
      .mockRejectedValueOnce(new Error('delta rejected'))
      .mockResolvedValue({ applied: true, partitionGeneration: 'next' })
    const getWithGeneration = vi.fn(async () => ({
      session: { ...getDefaultWorkspaceSession(), lastVisitedAtByWorktreeId: { unrelated: 9 } },
      partitionGeneration: 'fresh'
    }))
    const writer = new SessionUnitWriter({ patch, getWithGeneration })
    await writer.write(
      {
        patch: { lastVisitedAtByWorktreeId: { 'repo::/a': 3 } },
        keys: new Map([['lastVisitedAtByWorktreeId', new Set(['repo::/a'])]]),
        workspaces: new Set(),
        full: false
      },
      state
    )
    expect(getWithGeneration).toHaveBeenCalledTimes(1)
    expect(patch.mock.calls[1][0]).toEqual({
      expectedPartitionGeneration: 'fresh',
      lastVisitedAtByWorktreeId: { unrelated: 9, 'repo::/a': 3 }
    })
  })
})

function recencyUpdate(values: Record<string, number>, keys = Object.keys(values)) {
  return {
    patch: { lastVisitedAtByWorktreeId: values },
    keys: new Map([['lastVisitedAtByWorktreeId' as const, new Set(keys)]]),
    workspaces: new Set<string>(),
    full: false
  }
}

describe('partition acknowledgments and routing', () => {
  it('retries only the failed destination after mixed outcomes', async () => {
    const state = {
      ...fixture(),
      contestedPrimaryHostBySessionKey: { 'other::/b': 'runtime:remote' as const }
    }
    let failRemote = false
    const patch = vi.fn(async (_patch: WorkspaceSessionPatch, host?: string) => {
      if (failRemote && host === 'runtime:remote') {
        throw new Error('remote unavailable')
      }
      return { applied: true, partitionGeneration: 'applied' }
    })
    const writer = new SessionUnitWriter({ patch })
    await writer.write(recencyUpdate({ 'repo::/a': 1, 'other::/b': 1 }), state)
    failRemote = true
    patch.mockClear()
    await expect(
      writer.write(recencyUpdate({ 'repo::/a': 2, 'other::/b': 2 }), state)
    ).rejects.toThrow('remote unavailable')
    expect(patch).toHaveBeenCalledTimes(2)
    failRemote = false
    patch.mockClear()
    await writer.write(recencyUpdate({}), state)
    expect(patch).toHaveBeenCalledTimes(1)
    expect(patch.mock.calls[0][1]).toBe('runtime:remote')
    expect(patch.mock.calls[0][0].mapDeltas?.lastVisitedAtByWorktreeId?.set).toEqual({
      'other::/b': 2
    })
  })

  it('keeps an applied old-host removal when the new-host set fails', async () => {
    const state = fixture()
    let failRemote = true
    const patch = vi.fn(async (_patch: WorkspaceSessionPatch, host?: string) => {
      if (host === 'runtime:moved' && failRemote) {
        throw new Error('new host unavailable')
      }
      return { applied: true, partitionGeneration: 'applied' }
    })
    const writer = new SessionUnitWriter({ patch })
    await writer.write(recencyUpdate({ 'repo::/a': 1 }), state)
    const moved = {
      ...state,
      contestedPrimaryHostBySessionKey: { 'repo::/a': 'runtime:moved' as const }
    }
    patch.mockClear()
    await expect(writer.write(recencyUpdate({ 'repo::/a': 1 }), moved)).rejects.toThrow(
      'new host unavailable'
    )
    expect(
      patch.mock.calls.find((call) => !call[1])?.[0].mapDeltas?.lastVisitedAtByWorktreeId?.remove
    ).toEqual(['repo::/a'])
    failRemote = false
    patch.mockClear()
    await writer.write(recencyUpdate({}), moved)
    expect(patch).toHaveBeenCalledTimes(1)
    expect(patch.mock.calls[0][1]).toBe('runtime:moved')
  })

  it('retains explicit empty full-field obligations after a nonapplied ACK', async () => {
    const state = {
      ...fixture(),
      hydratedRuntimeSessionHostIds: ['ssh:target' as const, 'runtime:late' as const]
    }
    let fenced = true
    const patch = vi.fn(async (_patch: WorkspaceSessionPatch, host?: string) => ({
      applied: !(fenced && host === 'runtime:late'),
      partitionGeneration: 'head'
    }))
    const writer = new SessionUnitWriter({ patch })
    const empty = {
      patch: {
        sleepingAgentSessionsByPaneKey: {},
        remoteSessionIdsByTabId: {},
        lastVisitedAtByWorktreeId: {}
      },
      keys: new Map([
        ['sleepingAgentSessionsByPaneKey' as const, new Set<string>()],
        ['remoteSessionIdsByTabId' as const, new Set<string>()],
        ['lastVisitedAtByWorktreeId' as const, new Set<string>()]
      ]),
      workspaces: new Set<string>(),
      full: true
    }
    await expect(writer.write(empty, state)).rejects.toThrow('not applied')
    expect(patch.mock.calls.map((call) => call[1] ?? 'local').sort()).toEqual([
      'local',
      'runtime:late',
      'ssh:target'
    ])
    for (const [sent] of patch.mock.calls) {
      expect(sent).toMatchObject(empty.patch)
    }
    fenced = false
    patch.mockClear()
    await writer.write(recencyUpdate({}), state)
    expect(patch).toHaveBeenCalledTimes(1)
    expect(patch.mock.calls[0][1]).toBe('runtime:late')
    expect(patch.mock.calls[0][0]).toMatchObject(empty.patch)
  })
})

function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === 'object') {
    if (value instanceof Map || value instanceof Set) {
      return value
    }
    for (const child of Object.values(value)) {
      freezeSnapshot(child)
    }
    Object.freeze(value)
  }
  return value
}

it('matches full projection through dependent edits, deletion, routing and ordered full boundaries', () => {
  const owner = 'repo::/a',
    other = 'other::/b'
  const file = (worktreeId: string) => ({
    id: 'shared',
    filePath: '/shared.md',
    relativePath: 'shared.md',
    worktreeId,
    language: 'markdown',
    mode: 'edit' as const,
    isDirty: true
  })
  let state: AppState = {
    ...fixture(),
    openFiles: [file(owner), file(other), file(owner)],
    editorDrafts: { shared: 'first' },
    markdownFrontmatterVisible: { shared: true },
    ptyIdsByTabId: {},
    lastKnownRelayPtyIdByTabId: {},
    pendingReconnectPtyIdByTabId: {},
    deferredSshSessionIdsByTabId: {},
    activeFileIdByWorktree: { [owner]: 'shared', [other]: 'shared' },
    activeTabTypeByWorktree: { [owner]: 'editor', [other]: 'editor' },
    lastVisitedAtByWorktreeId: { [owner]: 1, [other]: 2 },
    sleepingAgentSessionsByPaneKey: {}
  }
  const projection = new SessionUnitProjection(state)
  let materialized = { ...getDefaultWorkspaceSession(), ...projection.full(state).patch }
  const steps: ((s: AppState) => AppState)[] = [
    (s) => ({
      ...s,
      tabsByWorktree: {
        ...s.tabsByWorktree,
        [owner]: s.tabsByWorktree[owner].map((row) => ({ ...row, customTitle: 'renamed' }))
      }
    }),
    (s) => ({ ...s, editorDrafts: { shared: 'second' } }),
    (s) => ({ ...s, openFiles: [s.openFiles[1], s.openFiles[2], s.openFiles[0]] }),
    (s) => ({ ...s, openFiles: s.openFiles.filter((row) => row.worktreeId !== owner) }),
    (s) => ({ ...s, openFiles: [], activeFileIdByWorktree: {}, activeTabTypeByWorktree: {} }),
    (s) => ({ ...s, lastVisitedAtByWorktreeId: { [other]: 3, [owner]: 4 } }),
    (s) => ({ ...s, contestedPrimaryHostBySessionKey: { [owner]: 'runtime:moved' } }),
    (s) => ({ ...s, tabsByWorktree: { [other]: s.tabsByWorktree[other] } })
  ]
  for (const edit of steps) {
    const prior = materialized
    const frozen = JSON.stringify(prior)
    freezeSnapshot(prior)
    const next = edit(state)
    const update = projection.update(next, discoverSessionSources(state, next))
    if (update.full) {
      materialized = { ...materialized, ...update.patch }
    } else {
      const deltas: SessionMapDeltas = {}
      const globals: WorkspaceSessionPatch = {}
      for (const [field, keys] of update.keys) {
        const values = update.patch[field] ?? {}
        Object.assign(deltas, {
          [field]: {
            set: Object.fromEntries(
              [...keys].filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]])
            ),
            remove: [...keys].filter((key) => !Object.hasOwn(values, key))
          }
        })
      }
      for (const [field, value] of Object.entries(update.patch)) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test controls the SessionMapField)) { fixture and intentionally supplies only the scenario's members.
        if (!update.keys.has(field as SessionMapField)) {
          Object.assign(globals, { [field]: value })
        }
      }
      materialized = { ...applySessionMapDeltas(materialized, deltas), ...globals }
    }
    const oracle = buildWorkspaceSessionPatch(next, SESSION_RELEVANT_FIELDS)
    for (const [field, expected] of Object.entries(oracle)) {
      if (field === 'activeWorktreeIdsOnShutdown' || field === 'activeConnectionIdsAtShutdown') {
        continue
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: oracle entries are keys of the workspace session patch.
      expect(materialized[field as keyof typeof materialized], field).toEqual(expected)
    }
    expect(JSON.stringify(prior)).toBe(frozen)
    state = next
  }
})
