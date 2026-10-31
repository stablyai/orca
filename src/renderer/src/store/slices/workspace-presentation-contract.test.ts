import { workspacePresentationMirror } from '../workspace-presentation-mirror'
import { resetWebSessionCloseIntentForTests } from '../../runtime/web-session-close-intent'
import { mergeFetchedWorktrees } from './worktrees/listing/fetched-worktree-merge'
// @vitest-environment happy-dom
import { createElement, useEffect } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { useStore, createStore } from 'zustand'
import type { AppState } from '../types'
import { withWorkspaceComposition } from '../workspace-composition'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../index'
import {
  seed,
  assertU,
  frame,
  O,
  D,
  C1,
  C2,
  listing,
  split
} from './workspace-presentation-test-fixture'
import {
  createTestStore,
  makeUnifiedTab,
  makeTabGroup,
  makeWorktree,
  makeOpenFile
} from './store-test-helpers'
import { createStoreSessionMockApi } from './store-session-test-harness'
import { mergeListedWorktreeSpellings } from './worktrees/session/worktree-spelling-merge'
import { buildWorktreePurgeState } from './worktrees/teardown/worktree-purge-state'
import {
  rawWorkspaceState,
  workspaceSourceWrite,
  workspacePresentationFor,
  failedWorkspaceTabCloseRestore
} from '../workspace-composition'
import { buildWorkspaceSessionPayload } from '../../lib/workspace-session'
import {
  isUnifiedTabOwnedByWorktree,
  isOpenFileOwnedByWorktree
} from '../../lib/unified-tab-host-ownership'
import { applyStructuredSessionTabSnapshots } from '../../runtime/local-structured-session-tabs-sync/snapshot-apply'
import { resetLocalStructuredSessionVersionForTests } from '../../runtime/local-structured-session-tabs-sync/inventory-generation-fence'
import {
  recentlyRenamedWorktreeIdExpiry,
  rememberWorktreeRename
} from '../../lib/worktree-rename-grace'
import { retireStructuredAgentSessionTab } from '../../runtime/structured-agent-session-tab-retirement'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { closeStructuredAgentSession } from '../../runtime/structured-agent-session-close'
import { findGroupAndWorktree } from './tab-group-state'
import { buildMobileSessionTabSnapshots } from '../../runtime/sync-runtime-graph/mobile-session-snapshots'
import { getActivatableBrowserWorkspaceTab } from '../../lib/browser-workspace-tab-activation'
import { captureLinkOpenIntent } from '../../lib/link-open-intent'
import { openLinkedFileInEditor } from '../../components/terminal-pane/terminal-file-link-editor-open'
import { structuredAgentSessionTargetForTab } from '../../runtime/structured-agent-session-owner'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('../../runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn().mockResolvedValue({})
}))
vi.mock('../../runtime/structured-agent-session-close', () => ({
  closeStructuredAgentSession: vi.fn().mockResolvedValue(undefined)
}))
createStoreSessionMockApi()
beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] })
  resetLocalStructuredSessionVersionForTests()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('source ownership through readers and commands', () => {
  it('admits a newly observed old source directly after listing, routes the real close IDs, and restores only failed-close placement on ordered live readback', async () => {
    const store = createTestStore()
    store.setState({
      worktreesByRepo: { r: listing.worktrees },
      repos: seed().getState().repos,
      activeWorktreeId: D
    })
    vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
    applyStructuredSessionTabSnapshots([frame(O, 'chat1', 200)])
    expect(store.getState().unifiedTabsByWorktree[D]?.map((tab) => tab.entityId)).toEqual(['chat1'])
    expect(rawWorkspaceState(store.getState()).unifiedTabsByWorktree[O][0].worktreeId).toBe(O)
    await retireStructuredAgentSessionTab({
      target: { kind: 'local' },
      worktreeId: O,
      sessionId: 'chat1'
    })
    expect(callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'session.tabs.close', {
      worktree: `id:${O}`,
      tabId: 'agent-session:chat1',
      reason: 'user'
    })
    expect(closeStructuredAgentSession).toHaveBeenCalledWith({ kind: 'local' }, 'chat1')
    const edited = seed()
    const restore = failedWorkspaceTabCloseRestore(
      edited.getState(),
      D,
      C1,
      edited.getState,
      edited.setState
    )
    const raw = rawWorkspaceState(edited.getState())
    edited.setState(
      workspaceSourceWrite(
        { unifiedTabsByWorktree: { ...raw.unifiedTabsByWorktree, [O]: [] } },
        { sources: [O] }
      )
    )
    expect(edited.getState().unifiedTabsByWorktree[D].map((tab) => tab.id)).toEqual([C2])
    edited.setState(
      workspaceSourceWrite({ unifiedTabsByWorktree: raw.unifiedTabsByWorktree }, { sources: [O] })
    )
    restore()
    expect(edited.getState().unifiedTabsByWorktree[D].find((tab) => tab.id === C1)).toMatchObject({
      groupId: 'left',
      customLabel: 'Saved name'
    })
    expect(edited.getState().layoutByWorktree[D]).toEqual(split)
  })
  it('buffers main placement until hydration completes and publishes it to unchanged workspace readers without changing raw membership', () => {
    const store = seed()
    let publish: Parameters<
      NonNullable<Parameters<typeof workspacePresentationMirror>[1]>
    >[0] = () => {}
    const original = Object.entries(store.getState().workspacePresentations ?? {})[0]
    const [key, saved] = original
    expect(saved).toBeDefined()
    if (!saved) {
      throw new Error('fixture presentation missing')
    }
    // The explicit subscriber supplies the already-selected local owner; IPC never supplies members.
    const mirror = workspacePresentationMirror(store, (listener) => {
      publish = listener
      return () => {}
    })
    const raw = rawWorkspaceState(store.getState())
    const edited = { ...saved, layout: { ...split, ratio: 0.61 } }
    publish({ changed: { [key]: edited }, removed: [] })
    mirror.activate()
    expect(store.getState().layoutByWorktree[D]).toEqual({ ...split, ratio: 0.61 })
    expect(rawWorkspaceState(store.getState()).unifiedTabsByWorktree).toBe(
      raw.unifiedTabsByWorktree
    )
    mirror.close()
  })
  it('keeps unchanged genuine sources when an ordinary view action edits another workspace', () => {
    const store = seed()
    const before = rawWorkspaceState(store.getState())
    const other = 'other::/repo'
    store.setState({
      unifiedTabsByWorktree: {
        ...before.unifiedTabsByWorktree,
        [other]: [makeUnifiedTab({ id: 'other', worktreeId: other })]
      }
    })
    const after = rawWorkspaceState(store.getState())
    expect(after.unifiedTabsByWorktree[O]).toBe(before.unifiedTabsByWorktree[O])
    expect(after.unifiedTabsByWorktree[D]).toBe(before.unifiedTabsByWorktree[D])
    expect(after.unifiedTabsByWorktree[other]).toHaveLength(1)
    assertU(store)
    store
      .getState()
      .moveUnifiedTabToGroup(C1, 'right', { activate: true, recordInteraction: false })
    expect(before.unifiedTabsByWorktree[O][0].groupId).toBe('source')
    expect(rawWorkspaceState(store.getState()).unifiedTabsByWorktree[O][0].groupId).toBe('source')
    expect(store.getState().unifiedTabsByWorktree[D].find((tab) => tab.id === C1)?.groupId).toBe(
      'right'
    )
  })
  it('keeps source-local close and retraction separate from same-host duplicate claims and unrelated hosts', () => {
    const store = seed()
    const raw = rawWorkspaceState(store.getState())
    store.setState(
      workspaceSourceWrite(
        {
          unifiedTabsByWorktree: {
            ...raw.unifiedTabsByWorktree,
            [D]: [
              ...raw.unifiedTabsByWorktree[D],
              { ...raw.unifiedTabsByWorktree[O][0], worktreeId: D, groupId: 'right' }
            ]
          }
        },
        { sources: [D] }
      )
    )
    const withClaim = rawWorkspaceState(store.getState())
    store.setState(
      workspaceSourceWrite(
        { unifiedTabsByWorktree: { ...withClaim.unifiedTabsByWorktree, [O]: [] } },
        { sources: [O] }
      )
    )
    expect(
      store
        .getState()
        .unifiedTabsByWorktree[D].map((tab) => tab.entityId)
        .sort()
    ).toEqual(['chat1', 'chat2'])
    const live = rawWorkspaceState(store.getState())
    store.setState(
      workspaceSourceWrite(
        {
          unifiedTabsByWorktree: {
            ...live.unifiedTabsByWorktree,
            [D]: live.unifiedTabsByWorktree[D].filter((tab) => tab.entityId !== 'chat1')
          }
        },
        { sources: [D] }
      )
    )
    expect(store.getState().unifiedTabsByWorktree[D].map((tab) => tab.entityId)).toEqual(['chat2'])
    const foreign = 'other::C:/repo'
    store.setState(
      workspaceSourceWrite(
        {
          unifiedTabsByWorktree: {
            ...rawWorkspaceState(store.getState()).unifiedTabsByWorktree,
            [foreign]: [
              makeUnifiedTab({
                id: C1,
                entityId: 'chat1',
                worktreeId: foreign,
                executionHostId: 'runtime:other'
              })
            ]
          }
        },
        { sources: [foreign] }
      )
    )
    expect(store.getState().unifiedTabsByWorktree[foreign][0].entityId).toBe('chat1')
    store.setState(buildWorktreePurgeState(store.getState(), [{ id: D, hostId: 'local' }]))
    expect(store.getState().unifiedTabsByWorktree[foreign]).toHaveLength(1)
    expect(workspacePresentationFor(store.getState(), O)).toBeUndefined()
    expect(workspacePresentationFor(store.getState(), D)).toBeUndefined()
  })
  it('keeps dirty file and browser addresses, host partitions and graph egress genuine after composition', () => {
    const store = seed()
    const file = makeOpenFile({
      id: 'file',
      filePath: 'C:/repo/a.ts',
      worktreeId: O,
      isDirty: true
    })
    const raw = rawWorkspaceState(store.getState())
    const browser = {
      id: 'browser',
      worktreeId: O,
      label: 'Browser',
      sessionProfileId: 'default',
      sessionPartition: 'default',
      pageIds: ['page'],
      activePageId: 'page',
      createdAt: 1
    }
    store.setState(
      workspaceSourceWrite(
        {
          openFiles: [file],
          editorDrafts: { file: 'unsaved' },
          browserTabsByWorktree: { [O]: [browser] },
          groupsByWorktree: {
            ...raw.groupsByWorktree,
            [O]: raw.groupsByWorktree[O].map((group) => ({
              ...group,
              tabOrder: [...group.tabOrder, 'browser-tab']
            }))
          },
          unifiedTabsByWorktree: {
            ...raw.unifiedTabsByWorktree,
            [O]: [
              ...raw.unifiedTabsByWorktree[O],
              makeUnifiedTab({
                id: 'browser-tab',
                entityId: 'browser',
                worktreeId: O,
                groupId: 'source',
                contentType: 'browser'
              })
            ]
          }
        },
        { sources: [O] }
      )
    )
    vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
    const state = store.getState()
    expect(
      isUnifiedTabOwnedByWorktree(
        state.unifiedTabsByWorktree[D][0],
        listing.worktrees[0],
        new Set()
      )
    ).toBe(true)
    expect(isOpenFileOwnedByWorktree(file, listing.worktrees[0])).toBe(true)
    const payload = buildWorkspaceSessionPayload(state)
    expect(payload.openFilesByWorktree?.[O]?.[0].dirtyDraftContent).toBe('unsaved')
    expect(payload.unifiedTabs?.[D]?.map((tab) => tab.entityId)).toEqual(['chat2'])
    expect(payload.browserTabsByWorktree?.[O]?.[0].worktreeId).toBe(O)
    const graph = buildMobileSessionTabSnapshots(state, false)
    expect(
      graph.find((snapshot) => snapshot.worktree === D)?.tabs.some((tab) => tab.type === 'browser')
    ).toBe(false)
    expect(
      graph.find((snapshot) => snapshot.worktree === O)?.tabs.some((tab) => tab.type === 'browser')
    ).toBe(true)
    expect(
      findGroupAndWorktree(
        {
          one: [makeTabGroup({ id: 'left', worktreeId: 'one' })],
          two: [makeTabGroup({ id: 'left', worktreeId: 'two' })]
        },
        'left'
      )
    ).toBeNull()
    expect(
      getActivatableBrowserWorkspaceTab({ worktreeId: D, workspaceId: 'browser' })?.worktreeId
    ).toBe(O)
    const intent = captureLinkOpenIntent(store.getState(), O, C1, { explicitSourceGroup: true })
    expect(intent?.targetGroupId).toBe('left')
    const opened = openLinkedFileInEditor(
      { filePath: 'C:/repo/link.ts', relativePath: 'link.ts', worktreeId: O },
      intent,
      { line: 7, column: 3 },
      () => true
    )
    expect(opened?.groupId).toBe('left')
    expect(
      store.getState().unifiedTabsByWorktree[D].find((tab) => tab.id === opened?.viewStateId)
    ).toMatchObject({ worktreeId: O, contentType: 'editor' })
    expect(
      rawWorkspaceState(store.getState()).unifiedTabsByWorktree[D].some(
        (tab) => tab.id === opened?.viewStateId
      )
    ).toBe(false)
    expect(store.getState().editorDrafts.file).toBe('unsaved')
  })
  it('keeps physical SSH identity while routing transport-stamped replies by the saved row-qualified runtime association', () => {
    const store = seed('ssh:target')
    const raw = rawWorkspaceState(store.getState())
    const rows = raw.worktreesByRepo.r.map((row) => ({ ...row, runtimeOwnerEnvironmentId: 'box' }))
    store.setState(
      workspaceSourceWrite({
        worktreesByRepo: { r: rows },
        restoredRuntimeHostIdByWorkspaceSessionKey: { [O]: 'runtime:box', [D]: 'runtime:box' },
        workspacePresentations: {}
      })
    )
    store.setState(
      mergeListedWorktreeSpellings(store.getState(), 'r', 'runtime:box', { worktrees: rows })
    )
    const before = rawWorkspaceState(store.getState())
    store.setState(
      workspaceSourceWrite(
        {
          unifiedTabsByWorktree: {
            ...before.unifiedTabsByWorktree,
            [O]: before.unifiedTabsByWorktree[O].map((tab) => ({
              ...tab,
              executionHostId: 'runtime:box'
            }))
          }
        },
        { sources: [O] }
      )
    )
    const tab = store.getState().unifiedTabsByWorktree[D].find((tab) => tab.id === C1)!
    expect(tab.executionHostId).toBe('ssh:target')
    expect(structuredAgentSessionTargetForTab(store.getState(), tab)).toEqual({
      kind: 'environment',
      environmentId: 'box'
    })
    expect(
      structuredAgentSessionTargetForTab({ ...store.getState(), workspacePresentations: {} }, tab)
    ).toBeNull()
  })
})

describe('bounded discovery and isolated read subscriptions', () => {
  async function corpus(repos: number, files: number, alias: boolean) {
    resetLocalStructuredSessionVersionForTests()
    resetWebSessionCloseIntentForTests()
    const store = createTestStore()
    const sources = Object.fromEntries(
      Array.from({ length: repos }, (_, index) => {
        const id = `r${index}::C:${alias ? '\\' : '/'}repo`
        return [
          id,
          [
            makeUnifiedTab({
              id: `structured-agent-session-chat${index}`,
              entityId: `chat${index}`,
              contentType: 'agent-session',
              executionHostId: 'local',
              worktreeId: id,
              groupId: `g${index}`
            })
          ]
        ]
      })
    )
    let keys = 0,
      fileReads = 0
    const sourceMap = new Proxy(sources, {
      ownKeys: (target) => {
        const rows = Reflect.ownKeys(target)
        keys += rows.length
        return rows
      }
    })
    const openFiles = Array.from({ length: files }, (_, index) => {
      const file = makeOpenFile({ id: `file${index}`, worktreeId: `unrelated::/files/${index}` })
      return new Proxy(file, {
        get: (target, key, receiver) => {
          if (key === 'worktreeId') {
            fileReads++
          }
          return Reflect.get(target, key, receiver)
        }
      })
    })
    const worktreesByRepo = Object.fromEntries(
      Array.from({ length: repos }, (_, index) => [
        `r${index}`,
        [makeWorktree({ id: `r${index}::C:/repo`, repoId: `r${index}`, path: 'C:/repo' })]
      ])
    )
    store.setState(
      workspaceSourceWrite({
        unifiedTabsByWorktree: sourceMap,
        repos: Object.keys(worktreesByRepo).map((id) => ({
          id,
          path: 'C:/repo',
          displayName: id,
          badgeColor: '#000',
          addedAt: 0
        })),
        openFiles,
        worktreesByRepo,
        groupsByWorktree: Object.fromEntries(
          Object.entries(sources).map(([id, tabs]) => [
            id,
            [makeTabGroup({ id: tabs[0].groupId, worktreeId: id, tabOrder: [tabs[0].id] })]
          ])
        )
      })
    )
    const refresh = () => {
      for (const [repoId, rows] of Object.entries(worktreesByRepo)) {
        expect(
          mergeFetchedWorktrees(store.setState, store.getState, {
            repoId,
            hostId: 'local',
            ownerWasMissingAtStart: false,
            requestStartedWorktrees: rows,
            refresh: {
              status: 'admitted',
              executionHostId: 'local',
              result: { worktrees: rows, authoritative: true, source: 'git' }
            },
            purgeRemovedWorktrees: false
          })
        ).toBe('applied')
      }
    }
    keys = 0
    fileReads = 0
    refresh()
    const initial = { keys, fileReads }
    keys = 0
    fileReads = 0
    refresh()
    expect(keys).toBe(0)
    expect(fileReads).toBe(0)
    const spy = vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
    const identities = Object.keys(store.getState().workspacePresentations ?? {}).length
    keys = 0
    fileReads = 0
    applyStructuredSessionTabSnapshots(
      Object.keys(sources).map((workspace, index) => frame(workspace, `chat${index}`, 2))
    )
    const inventory = { keys, fileReads }
    expect(inventory.fileReads).toBeLessThanOrEqual(files)
    keys = 0
    fileReads = 0
    store.getState().closeUnifiedTab('structured-agent-session-chat0')
    await retireStructuredAgentSessionTab({
      target: { kind: 'local' },
      worktreeId: Object.keys(sources)[0],
      sessionId: 'chat0'
    })
    const close = { keys, fileReads }
    keys = 0
    fileReads = 0
    store.setState(
      buildWorktreePurgeState(store.getState(), [{ id: 'r0::C:/repo', hostId: 'local' }])
    )
    const cleanup = { keys, fileReads }
    expect(store.getState().unifiedTabsByWorktree['r0::C:/repo'] ?? []).toEqual([])
    spy.mockRestore()
    return { ...initial, identities, inventory, close, cleanup }
  }
  it('indexes once for production N/10N listings, independently scaled unrelated files and aliases, and benchmarks a short realistic corpus', async () => {
    const rows = []
    for (const alias of [false, true]) {
      const small = await corpus(20, 200, alias)
      const manyRepos = await corpus(200, 200, alias)
      const manyFiles = await corpus(20, 2000, alias)
      expect(manyRepos.keys).toBeLessThanOrEqual(small.keys * 10)
      expect(manyRepos.fileReads).toBe(small.fileReads)
      expect(manyFiles.fileReads).toBeLessThanOrEqual(small.fileReads * 10)
      expect(manyFiles.keys).toBe(small.keys)
      expect(manyRepos.cleanup.fileReads).toBeLessThanOrEqual(small.cleanup.fileReads + 10)
      expect(manyFiles.cleanup.fileReads).toBeLessThanOrEqual(small.cleanup.fileReads * 10)
      expect(manyRepos.close.fileReads).toBe(small.close.fileReads)
      rows.push({ alias, small, manyRepos, manyFiles })
    }
    console.info('workspace presentation operation corpus', JSON.stringify(rows))
    const started = performance.now()
    const realistic = await corpus(120, 6550, true)
    console.info(
      'workspace presentation short corpus',
      JSON.stringify({ ...realistic, elapsedMs: performance.now() - started })
    )
    expect(realistic.identities).toBe(120)
  })
  it('delivers the changed identity while rendering no unrelated row, including another host, after settled effects and separate act turns', async () => {
    const store = seed()
    const other = 'other::/repo'
    store.setState(
      workspaceSourceWrite(
        {
          unifiedTabsByWorktree: {
            ...rawWorkspaceState(store.getState()).unifiedTabsByWorktree,
            [other]: [
              makeUnifiedTab({ id: 'other', worktreeId: other, executionHostId: 'runtime:other' })
            ]
          }
        },
        { sources: [other] }
      )
    )
    const renders = { current: 0, other: 0 },
      effects = { current: 0, other: 0 }
    function Row({ id, name }: { id: string; name: 'current' | 'other' }) {
      useStore(store, (state) => state.unifiedTabsByWorktree[id])
      renders[name]++
      useEffect(() => {
        effects[name]++
      }, [name])
      return null
    }
    render(
      createElement(
        'div',
        null,
        createElement(Row, { id: D, name: 'current' }),
        createElement(Row, { id: other, name: 'other' })
      )
    )
    await act(async () => {})
    expect(effects).toEqual({ current: 1, other: 1 })
    renders.current = 0
    renders.other = 0
    await act(async () => {
      store.setState({ sortEpoch: 42 })
    })
    expect(renders).toEqual({ current: 0, other: 0 })
    await act(async () => {
      const raw = rawWorkspaceState(store.getState())
      store.setState(
        workspaceSourceWrite(
          {
            unifiedTabsByWorktree: {
              ...raw.unifiedTabsByWorktree,
              [other]: raw.unifiedTabsByWorktree[other].map((tab) => ({
                ...tab,
                label: 'Other host changed'
              }))
            }
          },
          { sources: [other] }
        )
      )
    })
    expect(renders).toEqual({ current: 0, other: 1 })
    await act(async () => {
      const raw = rawWorkspaceState(store.getState())
      store.setState(
        workspaceSourceWrite(
          {
            unifiedTabsByWorktree: {
              ...raw.unifiedTabsByWorktree,
              [O]: raw.unifiedTabsByWorktree[O].map((tab) => ({ ...tab, label: 'Source changed' }))
            }
          },
          { sources: [O] }
        )
      )
    })
    expect(renders).toEqual({ current: 1, other: 1 })
    assertU(store)
  })
  it('expires remaining explicit-rename receipts from one writer-owned timer', () => {
    vi.useFakeTimers()
    recentlyRenamedWorktreeIdExpiry.clear()
    rememberWorktreeRename(O, D)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(20_001)
    expect(recentlyRenamedWorktreeIdExpiry.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})

it('keeps exact source ownership after physical rename, a new-source frame, repeated notification and real native close', async () => {
  const store = seed()
  vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
  const N = 'r::C:/renamed'
  store.getState().migrateWorktreeIdentity(D, N)
  const renamed = store.getState()
  expect(rawWorkspaceState(renamed).unifiedTabsByWorktree[O]?.map((tab) => tab.entityId)).toEqual([
    'chat1'
  ])
  expect(rawWorkspaceState(renamed).unifiedTabsByWorktree[N]?.map((tab) => tab.entityId)).toEqual([
    'chat2'
  ])
  expect(
    Object.values(renamed.workspacePresentations ?? {}).some(
      (saved) => saved?.displayWorkspaceId === D
    )
  ).toBe(false)
  applyStructuredSessionTabSnapshots([frame(N, 'chat2', 3)])
  store.getState().migrateWorktreeIdentity(D, N)
  expect(
    store
      .getState()
      .unifiedTabsByWorktree[N]?.map((tab) => tab.id)
      .sort()
  ).toEqual([C1, C2])
  expect(store.getState().layoutByWorktree[N]).toEqual(split)
  store.getState().closeUnifiedTab(C1)
  await Promise.resolve()
  await Promise.resolve()
  expect(closeStructuredAgentSession).toHaveBeenCalledWith({ kind: 'local' }, 'chat1')
  expect(callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'session.tabs.close', {
    worktree: `id:${O}`,
    tabId: 'agent-session:chat1',
    reason: 'user'
  })
  expect(store.getState().unifiedTabsByWorktree[N]?.map((tab) => tab.entityId)).toEqual(['chat2'])
})

it('qualifies an actual reordered drop by its members when another workspace uses the same group ID', () => {
  const store = seed()
  const other = 'other::/repo'
  const foreign = makeUnifiedTab({
    id: 'foreign',
    entityId: 'foreign',
    worktreeId: other,
    groupId: 'right'
  })
  store.setState((raw) => ({
    groupsByWorktree: {
      [other]: [
        makeTabGroup({
          id: 'right',
          worktreeId: other,
          tabOrder: ['foreign'],
          activeTabId: 'foreign'
        })
      ],
      ...raw.groupsByWorktree
    },
    unifiedTabsByWorktree: { [other]: [foreign], ...raw.unifiedTabsByWorktree }
  }))
  expect(store.getState().dropUnifiedTab(C1, { groupId: 'right' })).toBe(true)
  store.getState().reorderUnifiedTabs('right', [C2, C1], { recordInteraction: false })
  expect(
    store.getState().groupsByWorktree[D].find((group) => group.id === 'right')?.tabOrder
  ).toEqual([C2, C1])
  expect(
    rawWorkspaceState(store.getState()).unifiedTabsByWorktree[O].map((tab) => tab.entityId)
  ).toEqual(['chat1'])
  expect(rawWorkspaceState(store.getState()).groupsByWorktree[other][0].tabOrder).toEqual([
    'foreign'
  ])
})

it('keeps direct functional writes and action reducers raw while explicit outer creation/placement stays in U', () => {
  const store = seed()
  const raw = rawWorkspaceState(store.getState())
  store.setState((current) => {
    expect(current.unifiedTabsByWorktree[O]).toBe(raw.unifiedTabsByWorktree[O])
    expect(current.unifiedTabsByWorktree[D].map((tab) => tab.entityId)).toEqual(['chat2'])
    return { activeFileId: null }
  })
  const commandReads: (() => AppState)[] = []
  const commandStore = createStore<AppState>()(
    withWorkspaceComposition((set, get, api) => {
      commandReads.push(get, api.getState)
      return {
        ...raw,
        setActiveTabType: () =>
          set((current) => {
            expect(current.unifiedTabsByWorktree[D].map((tab) => tab.entityId)).toEqual(['chat2'])
            expect(api.getState()).toBe(current)
            return { activeFileId: 'command' }
          })
      }
    })
  )
  commandStore.setState({ workspacePresentations: raw.workspacePresentations })
  commandStore.getState().setActiveTabType('editor', D)
  for (const get of commandReads) {
    expect(get().unifiedTabsByWorktree[O]).toBe(raw.unifiedTabsByWorktree[O])
  }
  commandStore.setState((current) => ({ ...current, activeFileId: 'replacement' }), true)
  expect(rawWorkspaceState(commandStore.getState()).activeFileId).toBe('replacement')
  expect(
    rawWorkspaceState(commandStore.getState()).unifiedTabsByWorktree[D].map((tab) => tab.entityId)
  ).toEqual(['chat2'])
  expect(
    commandStore
      .getState()
      .unifiedTabsByWorktree[D].map((tab) => tab.entityId)
      .sort()
  ).toEqual(['chat1', 'chat2'])
  const outerGroupId = store.getState().createEmptySplitGroup(D, 'left', 'right')
  const outerGroup = store
    .getState()
    .groupsByWorktree[D].find((group) => group.id === outerGroupId)!
  const created = store.getState().createUnifiedTab(D, 'agent-session', {
    id: 'new',
    entityId: 'new',
    targetGroupId: outerGroup.id,
    agentSessionAgent: 'codex'
  })
  expect(created.groupId).toBe(outerGroup.id)
  expect(
    rawWorkspaceState(store.getState()).unifiedTabsByWorktree[D].find((tab) => tab.id === 'new')
      ?.groupId
  ).not.toBe(outerGroup.id)
  expect(rawWorkspaceState(store.getState()).unifiedTabsByWorktree[O]).toBe(
    raw.unifiedTabsByWorktree[O]
  )
  expect(store.getState().unifiedTabsByWorktree[D].find((tab) => tab.id === 'new')?.groupId).toBe(
    outerGroup.id
  )
})
