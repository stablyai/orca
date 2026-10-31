// @vitest-environment happy-dom
import type * as AppStoreModule from '../index'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { StoreApi } from 'zustand'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { WorkspacePresentationDelta } from '../../../../shared/workspace-presentation'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { seed, seedEditors, O, D } from './workspace-presentation-test-fixture'
import { makeOpenFile, makeUnifiedTab, makeWorktree, createTestStore } from './store-test-helpers'
import { createStoreSessionMockApi } from './store-session-test-harness'
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
    store.getState().markFileDirty('old-input-0', true)
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
