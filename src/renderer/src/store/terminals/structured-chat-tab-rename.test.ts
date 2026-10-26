import { toast } from 'sonner'
import { createTerminalTabAppearanceActions } from './terminal-tab-appearance'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import { createTestStore, makeWorktree, seedStore } from '../slices/store-test-helpers'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type * as SessionClient from '@/runtime/structured-agent-session-client'
import { routeTerminalTabChangesThroughLayoutOwner } from './terminal-tab-layout-owner-actions'
import { makeFolderWorkspace } from '../slices/worktrees-slice-test-fixtures'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

const { hostRename, hostSavesNames } = vi.hoisted(() => ({
  hostRename: vi.fn(async (_params: unknown, _target?: RuntimeClientTarget) => ({
    name: 'Flaky retry test',
    applied: true
  })),
  hostSavesNames: vi.fn(async () => true)
}))

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const client = (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
  return {
    ...client,
    callRuntimeRpc: (...args: Parameters<typeof client.callRuntimeRpc>) =>
      args[1] === 'agentSession.rename'
        ? hostRename(args[2], args[0])
        : client.callRuntimeRpc(...args)
  }
})

vi.mock('@/runtime/structured-agent-session-client', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionClient>()),
  supportsStructuredAgentSessionRename: hostSavesNames
}))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

const WORKTREE = 'local-repo::/tmp/app'
const STRUCTURED_TAB_ID = 'structured-agent-session-codex-1'

function structuredTab(): Tab {
  return {
    id: STRUCTURED_TAB_ID,
    entityId: 'codex-1',
    groupId: 'group-1',
    worktreeId: WORKTREE,
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    label: 'Codex Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

const TERMINAL_TAB_ID = 'terminal-1'
const TERMINAL_UNIFIED_ID = 'unified-terminal-1'

function terminalTab(): Tab {
  return {
    id: TERMINAL_UNIFIED_ID,
    entityId: TERMINAL_TAB_ID,
    groupId: 'group-1',
    worktreeId: WORKTREE,
    contentType: 'terminal',
    label: 'Terminal',
    customLabel: null,
    color: null,
    sortOrder: 1,
    createdAt: 2
  }
}

function storeWithStructuredTab(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seedStore(store, {
    repos: [{ id: 'local-repo', path: '/tmp/app', name: 'app' }] as never,
    worktreesByRepo: {
      'local-repo': [makeWorktree({ id: WORKTREE, repoId: 'local-repo', path: '/tmp/app' })]
    },
    unifiedTabsByWorktree: { [WORKTREE]: [structuredTab()] }
  })
  return store
}

function labelOf(store: ReturnType<typeof createTestStore>): string | null | undefined {
  return store
    .getState()
    .unifiedTabsByWorktree[WORKTREE]?.find((tab) => tab.id === STRUCTURED_TAB_ID)?.customLabel
}

function colorOf(store: ReturnType<typeof createTestStore>): string | null | undefined {
  return store
    .getState()
    .unifiedTabsByWorktree[WORKTREE]?.find((tab) => tab.id === STRUCTURED_TAB_ID)?.color
}

/** A layout-owner build sends the change to main, whose frame draws it; otherwise the window does. */
function expectChange(windowShows: () => void, mainGets: Record<string, unknown>): void {
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    expect(layoutApplyTestTransport.sent.at(-1)).toEqual(
      expect.objectContaining({ workspace: WORKTREE, ...mainGets })
    )
  } else {
    windowShows()
  }
}

describe('renaming a terminal tab still resolves', () => {
  it('routes a terminal rename through its entityId, not the unified id', async () => {
    const store = createTestStore()
    seedStore(store, {
      repos: [{ id: 'local-repo', path: '/tmp/app', name: 'app' }] as never,
      worktreesByRepo: {
        'local-repo': [makeWorktree({ id: WORKTREE, repoId: 'local-repo', path: '/tmp/app' })]
      },
      unifiedTabsByWorktree: { [WORKTREE]: [terminalTab(), structuredTab()] }
    })

    // Keyed by the TERMINAL's entityId — the structured tab must not absorb it.
    store.getState().setTabCustomTitle(TERMINAL_TAB_ID, 'Build logs')
    await layoutApplyTestTransport.settle()

    const tabs = store.getState().unifiedTabsByWorktree[WORKTREE] ?? []
    expectChange(
      () => expect(tabs.find((t) => t.id === TERMINAL_UNIFIED_ID)?.customLabel).toBe('Build logs'),
      { type: 'renameTab', tabId: TERMINAL_UNIFIED_ID, title: 'Build logs' }
    )
    expect(tabs.find((t) => t.id === STRUCTURED_TAB_ID)?.customLabel).toBeNull()
  })
})

describe('recoloring a structured chat tab', () => {
  it('writes the color onto the agent-session tab', async () => {
    const store = storeWithStructuredTab()
    store.getState().setTabColor(STRUCTURED_TAB_ID, 'red')
    await layoutApplyTestTransport.settle()
    expectChange(() => expect(colorOf(store)).toBe('red'), {
      type: 'setTabProps',
      tabId: STRUCTURED_TAB_ID,
      color: 'red'
    })
  })
})

describe('renaming a structured chat tab', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear()
    hostRename.mockClear()
    hostRename.mockResolvedValue({ name: 'Flaky retry test', applied: true })
    hostSavesNames.mockClear()
    hostSavesNames.mockResolvedValue(true)
  })

  it("saves the name on the chat's host, where Session History reads it, not on the tab", async () => {
    const store = storeWithStructuredTab()
    store.getState().setTabCustomTitle(STRUCTURED_TAB_ID, '  Flaky retry test ')
    await vi.waitFor(() =>
      expect(hostRename).toHaveBeenCalledWith(
        { sessionId: 'codex-1', name: 'Flaky retry test' },
        { kind: 'local' }
      )
    )
    await layoutApplyTestTransport.settle()
    expect(labelOf(store)).toBeNull()
    expect(layoutApplyTestTransport.sent).not.toContainEqual(
      expect.objectContaining({ type: 'renameTab', tabId: STRUCTURED_TAB_ID })
    )
    store.getState().setTabCustomLabel(STRUCTURED_TAB_ID, 'Old local alias')
    let answer = (_supported: boolean) => {}
    hostSavesNames.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve
        })
    )
    store.getState().setTabCustomTitle(STRUCTURED_TAB_ID, 'Updated local name')
    await vi.waitFor(() => expect(hostSavesNames).toHaveBeenCalledTimes(2))
    store.getState().setUnifiedTabColor(STRUCTURED_TAB_ID, 'red')
    store.setState({
      unifiedTabsByWorktree: {
        [WORKTREE]: store
          .getState()
          .unifiedTabsByWorktree[WORKTREE]!.map((tab) => ({ ...tab, executionHostId: 'local' }))
      }
    })
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      layoutApplyTestTransport.answerWith('pending')
    }
    answer(true)
    await vi.waitFor(() =>
      expect(hostRename).toHaveBeenLastCalledWith(
        { sessionId: 'codex-1', name: 'Updated local name' },
        { kind: 'local' }
      )
    )
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      await vi.waitFor(() => expect(layoutApplyTestTransport.pendingCount).toBe(1))
      store.getState().setUnifiedTabColor(STRUCTURED_TAB_ID, 'blue')
      layoutApplyTestTransport.answerPending()
      layoutApplyTestTransport.answerWith('accept')
    }
    await layoutApplyTestTransport.settle()
    await vi.waitFor(() => expect(labelOf(store)).toBeNull())
    expect(colorOf(store)).toBe(ORCA_LAYOUT_OWNER_IS_MAIN ? 'blue' : 'red')

    // Existing alias retirement is bookkeeping, not a reason to discard an explicit host write.
    hostSavesNames.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve
        })
    )
    store.getState().setTabCustomLabel(STRUCTURED_TAB_ID, 'Migrating alias')
    store.getState().setTabCustomTitle(STRUCTURED_TAB_ID, 'After migration')
    await vi.waitFor(() => expect(hostSavesNames).toHaveBeenCalledTimes(3))
    store.getState().setTabCustomLabel(STRUCTURED_TAB_ID, null)
    answer(true)
    await vi.waitFor(() => expect(hostRename).toHaveBeenCalledTimes(3))
    expect(hostRename).toHaveBeenLastCalledWith(
      { sessionId: 'codex-1', name: 'After migration' },
      { kind: 'local' }
    )
  })

  it.each(['window', 'main'] as const)(
    'captures an alias-free twin before the %s entry imports, and preserves newer intent',
    async (entry) => {
      const store = storeWithStructuredTab()
      const folder = makeFolderWorkspace({ id: 'twin' })
      const tab = { ...structuredTab(), worktreeId: folder.id }
      store.setState({
        unifiedTabsByWorktree: { [folder.id]: [tab] },
        activeWorktreeId: folder.id,
        activeWorkspaceExecutionHostId: 'runtime:b',
        folderWorkspaces: [
          { ...folder, executionHostId: 'runtime:a' },
          { ...folder, executionHostId: 'runtime:b' }
        ]
      })
      const windowActions = createTerminalTabAppearanceActions(store.setState, store.getState)
      const mainActions = routeTerminalTabChangesThroughLayoutOwner(
        { ...store.getState(), ...windowActions },
        store.getState
      )
      const actions = entry === 'main' ? mainActions : windowActions
      const otherActions = entry === 'main' ? windowActions : mainActions
      const current = () => store.getState().unifiedTabsByWorktree[folder.id][0]!
      let complete = () => {}
      hostRename.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = () => resolve({ name: 'First', applied: true })
          })
      )
      actions.setTabCustomTitle(tab.id, '  First  ')
      store.setState({
        activeWorktreeId: 'intermediate',
        activeWorkspaceExecutionHostId: 'runtime:a'
      })
      await vi.waitFor(() => expect(hostRename).toHaveBeenCalledTimes(1))
      store.getState().setUnifiedTabColor(tab.id, 'red')
      store.setState({ activeWorktreeId: 'elsewhere', activeWorkspaceExecutionHostId: 'runtime:a' })
      complete()
      await vi.waitFor(() => expect(current().customLabel).toBe('First'))
      expect(current().color).toBe('red')
      expect(hostRename).toHaveBeenLastCalledWith(
        { sessionId: tab.entityId, name: 'First' },
        { kind: 'environment', environmentId: 'b' }
      )
      expect(current().executionHostId).toBeUndefined()

      store.setState({ activeWorktreeId: folder.id, activeWorkspaceExecutionHostId: 'runtime:b' })
      hostRename.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = () => resolve({ name: 'Older', applied: true })
          })
      )
      actions.setTabCustomTitle(tab.id, 'Older')
      await vi.waitFor(() =>
        expect(hostRename).toHaveBeenLastCalledWith(
          { sessionId: tab.entityId, name: 'Older' },
          { kind: 'environment', environmentId: 'b' }
        )
      )
      const error = vi.spyOn(console, 'warn').mockImplementation(() => {})
      hostRename.mockRejectedValueOnce(new Error('Save refused'))
      store.getState().setUnifiedTabColor(tab.id, 'blue')
      otherActions.setTabCustomTitle(tab.id, 'Not saved')
      await vi.waitFor(() => expect(error).toHaveBeenCalled())
      expect(current().customLabel).toBe('First')
      expect(toast.error).toHaveBeenCalledExactlyOnceWith("Couldn't rename this chat")
      error.mockRestore()
      complete()
      await layoutApplyTestTransport.settle()
      expect(current().customLabel).toBe('First')
      let fail = (_error: Error) => {}
      hostRename.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject
          })
      )
      actions.setTabCustomTitle(tab.id, 'Older failure')
      await vi.waitFor(() => expect(hostRename).toHaveBeenCalledTimes(4))
      store.getState().setUnifiedTabColor(tab.id, 'green')
      otherActions.setTabCustomTitle(tab.id, 'Newer')
      await vi.waitFor(() => expect(current().customLabel).toBe('Newer'))
      vi.mocked(toast.error).mockClear()
      const staleError = vi.spyOn(console, 'warn').mockImplementation(() => {})
      fail(new Error('Obsolete failure'))
      await vi.waitFor(() => expect(staleError).toHaveBeenCalled())
      expect(toast.error).not.toHaveBeenCalled()
      staleError.mockRestore()

      hostRename.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = () => resolve({ name: 'Stale', applied: true })
          })
      )
      actions.setTabCustomTitle(tab.id, 'Stale')
      await vi.waitFor(() =>
        expect(hostRename).toHaveBeenLastCalledWith(
          { sessionId: tab.entityId, name: 'Stale' },
          { kind: 'environment', environmentId: 'b' }
        )
      )
      const replacement = { ...current(), customLabel: 'Replacement' }
      store.setState({ unifiedTabsByWorktree: { [folder.id]: [replacement] } })
      complete()
      await layoutApplyTestTransport.settle()
      expect(current()).toBe(replacement)

      actions.setTabCustomTitle(tab.id, 'After replacement')
      await vi.waitFor(() => expect(current().customLabel).toBe('After replacement'))
      let answer = (_supported: boolean) => {}
      hostSavesNames.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            answer = resolve
          })
      )
      actions.setTabCustomTitle(tab.id, 'Repointed')
      await vi.waitFor(() => expect(hostSavesNames).toHaveBeenCalledTimes(8))
      const repointed = { ...current(), entityId: 'another-session', createdAt: 2 }
      store.setState({ unifiedTabsByWorktree: { [folder.id]: [repointed] } })
      answer(true)
      await layoutApplyTestTransport.settle()
      expect(hostRename).toHaveBeenCalledTimes(7)
      expect(current()).toBe(repointed)
    }
  )

  it('keeps the name on the tab for a host too old to save it, and clears it when emptied', async () => {
    hostSavesNames.mockResolvedValue(false)
    const store = storeWithStructuredTab()
    store.getState().setTabCustomTitle(STRUCTURED_TAB_ID, 'Flaky retry test')
    await vi.waitFor(() => expect(hostSavesNames).toHaveBeenCalled())
    await layoutApplyTestTransport.settle()
    // Guard: without the intermediate assertion this case passes on a rename
    // that never wrote anything, since the label starts out null too.
    await vi.waitFor(() =>
      expectChange(() => expect(labelOf(store)).toBe('Flaky retry test'), {
        type: 'renameTab',
        tabId: STRUCTURED_TAB_ID,
        title: 'Flaky retry test'
      })
    )
    store.getState().setTabCustomTitle(STRUCTURED_TAB_ID, null)
    await layoutApplyTestTransport.settle()
    await vi.waitFor(() =>
      expectChange(() => expect(labelOf(store)).toBeNull(), {
        type: 'renameTab',
        tabId: STRUCTURED_TAB_ID,
        title: null
      })
    )
    expect(hostRename).not.toHaveBeenCalled()
  })
})
