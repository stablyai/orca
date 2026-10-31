// @vitest-environment happy-dom
import { buildWorktreePurgeState } from './worktrees/teardown/worktree-purge-state'
import type * as AppStoreModule from '../index'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { StoreApi } from 'zustand'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { WorkspacePresentationDelta } from '../../../../shared/workspace-presentation'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { seed, seedEditors, O, D } from './workspace-presentation-test-fixture'
import {
  makeOpenFile,
  makeUnifiedTab,
  makeWorktree,
  makeTab,
  createTestStore
} from './store-test-helpers'
import { createStoreSessionMockApi } from './store-session-test-harness'
import { makeBrowserTab } from './store-session-test-harness'
import {
  captureWorkspaceRemovalScope,
  currentWorkspaceRemovalSources,
  workspaceRemovalBrowserIsCurrent
} from './worktrees/teardown/workspace-removal-scope'
import { rawWorkspaceState } from '../workspace-source-state'
import { workspaceAdmittedFiles } from '../workspace-admitted-files'
import { useWorktreeFiles } from '../../components/terminal/use-worktree-files'
import { useAiVaultSessionDisplayTitle } from '../../components/right-sidebar/use-ai-vault-session-display-title'
const holder = vi.hoisted((): { store?: StoreApi<AppState> } => ({}))
vi.mock('@/store', async (original) => {
  const actual = await original<typeof AppStoreModule>()
  const { useStore: useBoundStore } = await import('zustand')
  const current = () => {
    if (!holder.store) {
      throw new Error('missing test store')
    }
    return holder.store
  }
  return {
    ...actual,
    useAppStore: Object.assign(
      <T,>(selector: (state: AppState) => T) => useBoundStore(current(), selector),
      {
        getState: () => current().getState(),
        setState: (patch: Partial<AppState>) => current().setState(patch),
        subscribe: (listener: (state: AppState, previous: AppState) => void) =>
          current().subscribe(listener)
      }
    )
  }
})
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn() } }))
const domWindow = window
const api = createStoreSessionMockApi()
Object.assign(domWindow, { api })
Object.assign(globalThis, { window: domWindow })
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function editors() {
  const store = seedEditors()
  holder.store = store
  return store
}

function strongInputs(root: object): Set<object> {
  const seen = new Set<object>()
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) {
      return
    }
    seen.add(value)
    if (value instanceof WeakMap || value instanceof WeakSet) {
      return
    }
    if (value instanceof Map) {
      for (const [key, entry] of value) {
        visit(key)
        visit(entry)
      }
    } else {
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if ('value' in descriptor) {
          visit(descriptor.value)
        }
      }
    }
  }
  visit(root)
  return seen
}
it.each([10, 100])(
  'releases no-history file derivation roots after %i real closes/purges without revisiting the helper',
  async (count) => {
    const { ImmutableInputCache } = await import('../../../../shared/immutable-input-cache')
    const cache = vi.spyOn(ImmutableInputCache.prototype, 'set')
    const store = createTestStore()
    const files = Array.from({ length: count }, (_, at) =>
      makeOpenFile({ id: `released-${at}`, worktreeId: `release::/folder-${at}` })
    )
    store.setState({ openFiles: files, activeWorktreeId: null, activeFileId: null })
    const inventories: object[] = []
    for (const file of files) {
      inventories.push(store.getState().openFiles)
      expect(workspaceAdmittedFiles(store.getState(), file.worktreeId)).toEqual([file])
      store.getState().closeFile(file.id, { captureRecentlyClosed: false })
    }
    store.setState(
      buildWorktreePurgeState(
        store.getState(),
        files.map((file) => ({ id: file.worktreeId, hostId: 'local' }))
      )
    )
    const current = store.getState()
    expect(current.openFiles).toEqual([])
    expect(current.recentlyClosedEditorTabsByWorktree).toEqual({})
    const fileCaches = cache.mock.contexts.filter((_, at) =>
      inventories.includes(cache.mock.calls[at][0][0])
    )
    expect(fileCaches.length).toBeGreaterThanOrEqual(count)
    for (const root of fileCaches) {
      const reached = strongInputs(root)
      expect(inventories.filter((array) => reached.has(array))).toEqual([])
      expect(reached.has(files[0])).toBe(false)
    }
  }
)
it.each([10, 100])(
  'keeps projection inputs narrow after a real dirty update at %i without helper revisit',
  async (count) => {
    const projection = await import('../workspace-composition-projection')
    const build = vi.spyOn(projection, 'buildWorkspaceProjection')
    const { ImmutableInputCache } = await import('../../../../shared/immutable-input-cache')
    const cache = vi.spyOn(ImmutableInputCache.prototype, 'set')
    const store = seed()
    const files = Array.from({ length: count }, (_, at) =>
      makeOpenFile({ id: `old-input-${at}`, worktreeId: O, isPreview: false })
    )
    store.setState({
      openFiles: files,
      activeWorktreeId: null,
      activeFileId: null,
      activeFileIdByWorktree: {}
    })
    const before = store.getState()
    expect(workspaceAdmittedFiles(before, D)).toHaveLength(count)
    const input = build.mock.calls.at(-1)?.[0]
    expect(input).toBeDefined()
    expect(Object.keys(input ?? {}).sort()).toEqual(
      [
        'workspacePresentations',
        'unifiedTabsByWorktree',
        'groupsByWorktree',
        'layoutByWorktree',
        'activeGroupIdByWorktree',
        'tabsByWorktree',
        'browserTabsByWorktree',
        'activeTabIdByWorktree',
        'activeFileIdByWorktree',
        'activeBrowserTabIdByWorktree',
        'activeTabTypeByWorktree'
      ].sort()
    )
    const calls = build.mock.calls.length
    const proxy = before.unifiedTabsByWorktree
    const dirty = before.markFileDirty
    dirty('old-input-0', true)
    // Inspect actual derivation owners before any post-write getter or helper can refresh them.
    for (const root of new Set(cache.mock.contexts)) {
      const reached = strongInputs(root)
      expect(reached.has(files)).toBe(false)
      expect(reached.has(rawWorkspaceState(before))).toBe(false)
    }
    const current = store.getState()
    expect(current.openFiles[0].isDirty).toBe(true)
    expect(current.openFiles).not.toBe(before.openFiles)
    expect(current.unifiedTabsByWorktree).toBe(proxy)
    expect(build).toHaveBeenCalledTimes(calls)
    expect(strongInputs(input ?? {}).has(before.openFiles)).toBe(false)
    expect(strongInputs(input ?? {}).has(rawWorkspaceState(before))).toBe(false)
  }
)

it('uses the same dirty preflight and accepted resource scope for displayed removal, preserving a foreign host and fencing old undo', async () => {
  const { collectRemovalUnsavedFiles } =
    await import('../../components/editor/removal-unsaved-editor-files')
  const { confirmUnsavedDiscard } =
    await import('./worktrees/teardown/removed-workspace-unsaved-files')
  const store = editors()
  Object.assign(window.api, { ephemeralVm: { listRuntimes: vi.fn(async () => []) } })
  // Keep the confirmed editor input bounded; native teardown has its own real dispatch contract.
  const raw = rawWorkspaceState(store.getState())
  store.setState({
    unifiedTabsByWorktree: {
      [O]: raw.unifiedTabsByWorktree[O].filter((tab) => tab.id === 'editor'),
      [D]: []
    }
  })
  expect(
    collectRemovalUnsavedFiles(store.getState, [{ id: D, hostId: 'local' }]).map((file) => file.id)
  ).toEqual(['owned'])
  const discarded = confirmUnsavedDiscard(store.getState, [{ id: D, hostId: 'local' }])
  api.worktrees.remove.mockRejectedValueOnce(new Error('backend refused'))
  expect(
    await store
      .getState()
      .removeWorktree({ id: D, executionHostId: 'local' }, true, { confirmedDiscards: discarded })
  ).toMatchObject({ ok: false })
  expect(store.getState().openFiles.map((file) => file.id)).toEqual(['owned', 'foreign'])
  expect(store.getState().unifiedTabsByWorktree[D].some((tab) => tab.id === 'editor')).toBe(true)
  api.worktrees.remove.mockResolvedValueOnce({})
  expect(
    await store
      .getState()
      .removeWorktree({ id: D, executionHostId: 'local' }, true, { confirmedDiscards: discarded })
  ).toEqual({ ok: true })
  expect(store.getState().worktreesByRepo.r).toEqual([])
  expect(store.getState().openFiles.map((file) => file.id)).toEqual(['foreign'])
  expect(rawWorkspaceState(store.getState()).unifiedTabsByWorktree[O] ?? []).toEqual([])
  expect(Object.keys(store.getState().workspacePresentations ?? {})).toEqual([])
  expect(store.getState().reopenClosedTab(D)).toBe(false)
})
it('does not spend an accepted removal receipt on a same-path replacement owner', async () => {
  const store = editors()
  const raw = rawWorkspaceState(store.getState())
  store.setState({
    unifiedTabsByWorktree: {
      [O]: raw.unifiedTabsByWorktree[O].filter((tab) => tab.id === 'editor'),
      [D]: []
    }
  })
  let finish: (result: {}) => void = () => {
    throw new Error('not started')
  }
  api.worktrees.remove.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const beforeCalls = api.worktrees.remove.mock.calls.length
  const pending = store.getState().removeWorktree({ id: D, executionHostId: 'local' }, true)
  await waitFor(() => expect(api.worktrees.remove).toHaveBeenCalledTimes(beforeCalls + 1))
  store.setState({
    worktreesByRepo: { r: [makeWorktree({ id: D, repoId: 'r', instanceId: 'replacement' })] }
  })
  finish({})
  expect(await pending).toMatchObject({ ok: false })
  expect(store.getState().openFiles.some((file) => file.id === 'owned')).toBe(true)
  expect(store.getState().worktreesByRepo.r[0].instanceId).toBe('replacement')
})

it.each([100, 1000])(
  'counts relevant-member work on unrelated title for %i admitted files',
  async (count) => {
    const store = editors()
    let ownerReads = 0
    const owned = rawWorkspaceState(store.getState()).openFiles.find((file) => file.id === 'owned')!
    const admitted = Array.from(
      { length: count },
      (_, at) =>
        new Proxy(at === 0 ? owned : makeOpenFile({ id: `admitted-${at}`, worktreeId: O }), {
          get(target, key, receiver) {
            if (key === 'worktreeId') {
              ownerReads++
            }
            return Reflect.get(target, key, receiver)
          }
        })
    )
    const unrelated = makeUnifiedTab({
      id: 'contract-unrelated',
      worktreeId: 'contract-other::/repo'
    })
    store.setState((raw) => ({
      openFiles: admitted,
      unifiedTabsByWorktree: { ...raw.unifiedTabsByWorktree, 'contract-other::/repo': [unrelated] }
    }))
    let renders = 0
    const shown = renderHook(() => {
      renders++
      return useWorktreeFiles(D)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(shown.result.current).toHaveLength(count)
    const previous = shown.result.current
    const priorRenders = renders
    ownerReads = 0
    await act(async () => {
      store.getState().setTabLabel('contract-unrelated', 'Changed')
    })
    const actualReads = ownerReads
    expect(shown.result.current).toBe(previous)
    expect(renders).toBe(priorRenders)
    expect(actualReads).toBe(0)
  }
)

it.each([100, 1000])(
  'counts history row source scans on an unrelated store write with %i source chats',
  async (count) => {
    const { makeTab } = await import('./store-test-helpers')
    const store = seed()
    holder.store = store
    let ids = 0
    const raw = rawWorkspaceState(store.getState())
    const chats = Array.from(
      { length: count },
      (_, at) =>
        new Proxy(
          makeUnifiedTab({
            id: `structured-agent-session-history-${at}`,
            entityId: `history-${at}`,
            worktreeId: O,
            groupId: 'source',
            contentType: 'agent-session',
            executionHostId: 'local',
            agentSessionAgent: 'codex',
            customLabel: `Saved ${at}`
          }),
          {
            get(target, key, receiver) {
              if (key === 'id') {
                ids++
              }
              return Reflect.get(target, key, receiver)
            }
          }
        )
    )
    store.setState({
      unifiedTabsByWorktree: { ...raw.unifiedTabsByWorktree, [O]: chats },
      groupsByWorktree: {
        ...raw.groupsByWorktree,
        [O]: [{ ...raw.groupsByWorktree[O][0], tabOrder: chats.map((tab) => tab.id) }]
      },
      tabsByWorktree: {
        ...raw.tabsByWorktree,
        'other::/pty': [makeTab({ id: 'other-pty', worktreeId: 'other::/pty' })]
      }
    })
    const session = {
      id: 'history-r4',
      executionHostId: 'local',
      agent: 'codex',
      sessionId: `history-${count - 1}`,
      title: 'Scanned title',
      cwd: 'C:/repo',
      branch: null,
      model: null,
      filePath: '',
      codexHome: null,
      createdAt: null,
      updatedAt: null,
      modifiedAt: '',
      messageCount: 0,
      totalTokens: 0,
      previewMessages: [],
      queuedMessageCount: 0,
      subagentTranscriptCount: 0,
      resumeCommand: '',
      subagent: null,
      structuredSession: { sessionId: `history-${count - 1}`, workspaceId: O }
    } satisfies AiVaultSession
    let renders = 0
    const shown = renderHook(() => {
      renders++
      return useAiVaultSessionDisplayTitle(session)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(shown.result.current).toBe(`Saved ${count - 1}`)
    const before = renders
    ids = 0
    await act(async () => {
      store.getState().setRuntimePaneTitle('other-pty', 0, 'Assistant busy')
    })
    const reads = ids
    expect(shown.result.current).toBe(`Saved ${count - 1}`)
    expect(renders).toBe(before)
    expect(reads).toBe(0)
  }
)

it('delivers relevant catalog and binding changes through the production file hook', async () => {
  const store = createTestStore()
  holder.store = store
  store.setState({
    activeWorktreeId: null,
    openFiles: [
      makeOpenFile({ id: 'local-r4', worktreeId: D }),
      makeOpenFile({ id: 'remote-r4', worktreeId: D, runtimeEnvironmentId: 'box' })
    ],
    worktreesByRepo: { r: [makeWorktree({ id: D, repoId: 'r', hostId: 'local' })] }
  })
  const shown = renderHook(() => useWorktreeFiles(D))
  await act(async () => {
    await Promise.resolve()
  })
  expect(shown.result.current.map((file) => file.id)).toEqual(['local-r4'])
  await act(async () => {
    store.setState({
      worktreesByRepo: { r: [makeWorktree({ id: D, repoId: 'r', hostId: 'runtime:box' })] }
    })
  })
  expect(shown.result.current.map((file) => file.id)).toEqual(['remote-r4'])
  shown.unmount()
  const recovered = editors()
  const hooked = renderHook(() => useWorktreeFiles(D))
  await act(async () => {
    await Promise.resolve()
  })
  expect(hooked.result.current.map((file) => file.id)).toEqual(['owned'])
  const { workspacePresentationMirror } = await import('../workspace-presentation-mirror')
  let publish: (delta: WorkspacePresentationDelta) => void = () => {
    throw new Error('not subscribed')
  }
  const mirror = workspacePresentationMirror(recovered, (listener) => {
    publish = listener
    return () => {}
  })
  mirror.activate()
  const docs = recovered.getState().workspacePresentations!
  const [key, document] = Object.entries(docs)[0]
  if (!document) {
    throw new Error('missing presentation')
  }
  await act(async () => {
    publish({
      changed: {
        [key]: {
          ...document,
          baseline: document.baseline.map((base) => ({
            ...base,
            source: { ...base.source, hostId: 'runtime:box', executionHostId: 'runtime:box' }
          }))
        }
      },
      removed: []
    })
  })
  expect(hooked.result.current.map((file) => file.id)).toEqual(['foreign'])
  hooked.unmount()
  mirror.close()
})

it.each([false, true])(
  'settles a held display removal with replaced backing resources=%s',
  async (replace) => {
    const store = editors()
    Object.assign(window.api, { ephemeralVm: { listRuntimes: vi.fn(async () => []) } })
    const raw = rawWorkspaceState(store.getState())
    const original = makeTab({
      id: 'removal-pty',
      worktreeId: O,
      generation: 1,
      ptyId: 'original-pty'
    })
    store.setState({
      unifiedTabsByWorktree: {
        [O]: [
          ...raw.unifiedTabsByWorktree[O].filter((tab) => tab.id === 'editor'),
          makeUnifiedTab({
            id: 'removal-terminal',
            entityId: original.id,
            contentType: 'terminal',
            worktreeId: O,
            executionHostId: 'local',
            groupId: 'source'
          })
        ],
        [D]: []
      },
      tabsByWorktree: { [O]: [original] },
      ptyIdsByTabId: { [original.id]: ['original-pty'] }
    })
    let finish: (result: {}) => void = () => {
      throw new Error('not started')
    }
    api.worktrees.remove.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const calls = api.worktrees.remove.mock.calls.length
    const pending = store.getState().removeWorktree({ id: D, executionHostId: 'local' }, true)
    await waitFor(() => expect(api.worktrees.remove).toHaveBeenCalledTimes(calls + 1))
    const current = rawWorkspaceState(store.getState())
    const replacement = { ...original, generation: 2, ptyId: 'replacement-pty' }
    if (replace) {
      store.setState({
        tabsByWorktree: { [O]: [replacement] },
        ptyIdsByTabId: { [original.id]: ['replacement-pty'] },
        openFiles: current.openFiles.map((file) =>
          file.id === 'owned' ? { ...file, filePath: 'C:/repo/replacement.ts' } : file
        )
      })
    }
    finish({})
    expect(await pending).toEqual({ ok: true })
    const after = rawWorkspaceState(store.getState())
    expect(after.worktreesByRepo.r).toEqual([])
    if (!replace) {
      expect(after.tabsByWorktree[O] ?? []).toEqual([])
      expect(after.unifiedTabsByWorktree[O] ?? []).toEqual([])
      expect(after.openFiles.map((file) => file.id)).toEqual(['foreign'])
      expect(Object.keys(after.workspacePresentations ?? {})).toHaveLength(0)
      return
    }
    expect(after.tabsByWorktree[O]).toEqual([replacement])
    expect(after.ptyIdsByTabId[original.id]).toEqual(['replacement-pty'])
    expect(after.openFiles.find((file) => file.id === 'owned')?.filePath).toBe(
      'C:/repo/replacement.ts'
    )
    expect(after.unifiedTabsByWorktree[O].map((tab) => tab.id)).toEqual([
      'editor',
      'removal-terminal'
    ])
    expect(Object.keys(after.workspacePresentations ?? {})).toHaveLength(1)
  }
)

it.each([10, 100])(
  'does not allocate permanent absent-source memo owners for %i recovered baselines',
  async (count) => {
    const { sourceBaseline } = await import('../../../../shared/workspace-presentation')
    const { ImmutableInputCache } = await import('../../../../shared/immutable-input-cache')
    const write = vi.spyOn(ImmutableInputCache.prototype, 'set')
    for (let at = 0; at < count; at++) {
      const source = { hostId: 'local' as const, workspaceId: `absent-${at}::C:/repo` }
      expect(sourceBaseline({}, source)).toEqual({
        source,
        tabs: [],
        groups: [],
        layout: undefined,
        activeGroupId: undefined
      })
    }
    expect(write).not.toHaveBeenCalled()
  }
)

it.each([100, 1000])(
  'indexes current removal resources and repeated browser admission at %i, retaining all outputs and replacement checks',
  (count) => {
    const store = createTestStore()
    let reads = 0
    const observe = <Row extends { id: string }>(row: Row): Row =>
      new Proxy(row, {
        get: (target, key, receiver) => {
          if (key === 'id') {
            reads++
          }
          return Reflect.get(target, key, receiver)
        }
      })
    const terminals = Array.from({ length: count }, (_, at) =>
      observe(makeTab({ id: `term-${at}`, worktreeId: D, generation: 1, ptyId: `pty-${at}` }))
    )
    const files = Array.from({ length: count }, (_, at) =>
      observe(makeOpenFile({ id: `file-${at}`, worktreeId: D }))
    )
    const browsers = Array.from({ length: count }, (_, at) =>
      observe(makeBrowserTab({ id: `browser-${at}`, worktreeId: D }))
    )
    const tabs = [
      ...terminals.map((tab) =>
        makeUnifiedTab({
          id: `unified-${tab.id}`,
          entityId: tab.id,
          worktreeId: D,
          contentType: 'terminal',
          executionHostId: 'local'
        })
      ),
      ...files.map((file) =>
        makeUnifiedTab({
          id: `unified-${file.id}`,
          entityId: file.id,
          worktreeId: D,
          contentType: 'editor',
          executionHostId: 'local'
        })
      ),
      ...browsers.map((tab) =>
        makeUnifiedTab({
          id: `unified-${tab.id}`,
          entityId: tab.id,
          worktreeId: D,
          contentType: 'browser',
          executionHostId: 'local'
        })
      )
    ]
    store.setState({
      tabsByWorktree: { [D]: terminals },
      unifiedTabsByWorktree: { [D]: tabs },
      openFiles: files,
      browserTabsByWorktree: { [D]: browsers }
    })
    const scope = captureWorkspaceRemovalScope(store.getState(), { id: D, hostId: 'local' })
    reads = 0
    const result = currentWorkspaceRemovalSources(store.getState(), scope)
    expect(result[0].terminals).toHaveLength(count)
    expect(result[0].files).toHaveLength(count)
    expect(result[0].browsers).toHaveLength(count)
    expect(result[0].tabs).toHaveLength(3 * count)
    const populatedReads = reads
    expect(populatedReads).toBeLessThanOrEqual(20 * count)
    const source = scope.sources[0]
    for (const browser of source.browsers) {
      expect(workspaceRemovalBrowserIsCurrent(store.getState(), scope, source, browser)).toBe(true)
    }
    const pointReads = reads - populatedReads
    expect(pointReads).toBeLessThanOrEqual(3 * count)
    expect(currentWorkspaceRemovalSources(store.getState(), scope)[0]).toBe(result[0])
    console.log(
      JSON.stringify({
        count,
        populatedReads,
        pointReads,
        terminals: result[0].terminals.length,
        files: result[0].files.length,
        browsers: result[0].browsers.length
      })
    )
    store.setState({
      browserTabsByWorktree: {
        [D]: browsers.map((tab, at) => (at ? tab : { ...tab, sessionProfileId: 'replacement' }))
      }
    })
    expect(
      workspaceRemovalBrowserIsCurrent(store.getState(), scope, source, source.browsers[0])
    ).toBe(false)
    const current = currentWorkspaceRemovalSources(store.getState(), scope)[0]
    expect(current.browsers).toHaveLength(count - 1)
    expect(current.tabs).toHaveLength(3 * count - 1)
  }
)
