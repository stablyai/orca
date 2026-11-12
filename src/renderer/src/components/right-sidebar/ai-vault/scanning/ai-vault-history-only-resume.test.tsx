// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { useAppStore } from '@/store/index'
import type { AiVaultSessionVirtualList } from '../session-list/AiVaultSessionVirtualList'
import {
  readAiVaultViewOptions,
  writeAiVaultViewOptions
} from '../scope/ai-vault-view-options-persistence'
import AiVaultPanel from '../panel/AiVaultPanel'
import { applyDetectedWorktreeUpdates } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import { selectDetectedWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { findAiVaultHistoryWorktree } from '@/lib/agent-session/resume/history/ai-vault-history-worktrees'
import { mergeFetchedWorktrees } from '@/store/slices/worktrees/listing/fetched-worktree-merge'
import { replaceDetectedWorktreeListing } from '@/store/slices/worktrees/listing/detected-worktree-publication'
import {
  historyResumeRowActions,
  expectHistoryCliStartup,
  connectHistoryCliPane,
  installHistoryHostTwin,
  publishStoppedHistoryListing,
  bare,
  bareId,
  checkout,
  checkoutId,
  inventory,
  nativeId,
  repo,
  session,
  settings
} from './ai-vault-history-only-resume.test-fixture'

const host = vi.hoisted(() => {
  const sessions: AiVaultSession[] = []
  const targets: Record<string, string | null> = {}
  return {
    sessions,
    targets,
    call: vi.fn<
      (target: RuntimeClientTarget, method: string, params: unknown) => Promise<unknown>
    >()
  }
})

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: (target: RuntimeClientTarget, method: string, params: unknown) =>
    host.call(target, method, params)
}))
vi.mock('./ai-vault-session-refresh', () => ({
  useAiVaultSessionRefresh: () => ({
    error: null,
    loading: false,
    refresh: vi.fn(),
    scanResult: null,
    scopePending: false,
    sessions: host.sessions,
    loadedSessionLimit: null
  })
}))
vi.mock('../session-actions/ai-vault-original-pane-actions', () => ({
  useAiVaultOriginalPaneActions: () => ({})
}))
vi.mock('../session-actions/ai-vault-session-delete-action', () => ({
  useAiVaultSessionDeleteAction: () => vi.fn()
}))
vi.mock('../session-list/AiVaultSessionVirtualList', () => ({
  AiVaultSessionVirtualList: ({
    groups,
    getSessionResumeState,
    getSessionResumeInChat,
    onResume
  }: Pick<
    ComponentProps<typeof AiVaultSessionVirtualList>,
    'groups' | 'getSessionResumeState' | 'getSessionResumeInChat' | 'onResume'
  >) => (
    <>
      {groups.flatMap((group) =>
        group.sessions.map((session) => {
          const actions = historyResumeRowActions(
            session,
            { getSessionResumeState, getSessionResumeInChat },
            host.targets
          )
          return (
            <button
              key={session.id}
              disabled={actions.resumeDisabled}
              onClick={() => {
                if (actions.resumeWorktreeId) {
                  onResume(session, actions.resumeWorktreeId)
                }
              }}
            >
              {session.title}
            </button>
          )
        })
      )}
    </>
  )
}))

beforeEach(() => {
  host.sessions = []
  host.targets = {}
  host.call.mockReset()
  host.call.mockResolvedValue({})
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings,
    repos: [repo],
    activeRepoId: repo.id,
    activeWorktreeId: bareId,
    activeWorkspaceExecutionHostId: 'local',
    worktreesByRepo: { [repo.id]: [checkout] },
    detectedWorktreesByRepo: {
      [repo.id]: { repoId: repo.id, source: 'git', authoritative: true, worktrees: [bare] }
    }
  })
  writeAiVaultViewOptions({ ...readAiVaultViewOptions(), sessionLimit: 500 })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      aiVault: {
        searchSessions: vi.fn(),
        prepareSessionResume: vi.fn(async () => ({ useRealCodexHome: false }))
      },
      ui: { writeClipboardText: vi.fn() },
      pty: {
        spawn: vi.fn<Window['api']['pty']['spawn']>(async () => ({ id: 'history-resume-pty' })),
        kill: vi.fn(),
        onData: vi.fn(() => () => {}),
        onReplay: vi.fn(() => () => {}),
        onExit: vi.fn(() => () => {})
      }
    }
  })
})
afterEach(() => {
  cleanup()
  window.localStorage.clear()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it('resumes a closed original bare CLI record through its cwd aliases and keeps ordinary/foreign targets distinct', async () => {
  const original = {
    ...session('provider-original', '/physical/storage/src', 'Original CLI'),
    cwdAliases: ['/repo/.bare/src']
  }
  const ordinary = session('provider-checkout', '/repo/checkout/src', 'Checkout CLI')
  const foreign: AiVaultSession = {
    ...original,
    id: 'foreign-record',
    title: 'Foreign CLI',
    executionHostId: 'runtime:other'
  }
  host.sessions = [original, ordinary, foreign]
  publishStoppedHistoryListing()
  expect(useAppStore.getState().tabsByWorktree[bareId]).toBeUndefined()
  expect(bare.visible).toBe(false)
  render(
    <AiVaultPanel workspace={{ worktreeId: 'unavailable-destination', executionHostId: 'local' }} />
  )
  fireEvent.click(screen.getByRole('radio', { name: /^All$/ }))
  expect(screen.getByRole('button', { name: 'Original CLI' })).toBeEnabled()
  expect(host.targets[original.id]).toBe(bareId)
  expect(screen.getByRole('button', { name: 'Checkout CLI' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Foreign CLI' })).toBeDisabled()
  act(() => {
    useAppStore.setState((state) => {
      const detected = selectDetectedWorktreesByRepo(state)
      const listing = detected[repo.id]
      return {
        detectedWorktreesByRepo: replaceDetectedWorktreeListing(detected, repo.id, {
          ...listing,
          worktrees: listing.worktrees.map((row) =>
            row.id === bareId && row.hostId === 'local'
              ? {
                  ...row,
                  path: '/relocated/storage',
                  displayName: 'Moved original',
                  priorWorktreeIds: [bareId]
                }
              : row
          )
        })
      }
    })
  })
  expect(host.targets[original.id]).toBe(bareId)
  expect(findAiVaultHistoryWorktree(useAppStore.getState(), bareId, 'local')?.path).toBe(
    '/relocated/storage'
  )
  act(() => {
    useAppStore.setState((state) => ({
      detectedWorktreesByRepo: applyDetectedWorktreeUpdates(
        selectDetectedWorktreesByRepo(state),
        bareId,
        { hostId: 'runtime:other' },
        'local'
      )
    }))
  })
  expect(screen.getByRole('button', { name: 'Original CLI' })).toBeDisabled()
  act(() => {
    useAppStore.setState((state) => ({
      detectedWorktreesByRepo: applyDetectedWorktreeUpdates(
        selectDetectedWorktreesByRepo(state),
        bareId,
        { hostId: 'local' },
        'runtime:other'
      )
    }))
  })
  expect(screen.getByRole('button', { name: 'Original CLI' })).toBeEnabled()
  act(() => {
    useAppStore.setState((state) => ({
      detectedWorktreesByRepo: applyDetectedWorktreeUpdates(
        selectDetectedWorktreesByRepo(state),
        bareId,
        { isArchived: true },
        'local'
      )
    }))
  })
  expect(screen.getByRole('button', { name: 'Original CLI' })).toBeDisabled()
  act(() => {
    useAppStore.setState((state) => ({
      detectedWorktreesByRepo: applyDetectedWorktreeUpdates(
        selectDetectedWorktreesByRepo(state),
        bareId,
        { isArchived: false },
        'local'
      )
    }))
  })
  expect(screen.getByRole('button', { name: 'Original CLI' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Original CLI' }))
  await waitFor(() => expect(useAppStore.getState().tabsByWorktree[bareId]).toHaveLength(1))
  const created = expectHistoryCliStartup(bareId, '/physical/storage/src', 'provider-original')
  expect(window.api.aiVault.prepareSessionResume).toHaveBeenCalledWith({
    agent: 'codex',
    sessionId: 'provider-original',
    filePath: '/history/provider-original.jsonl',
    codexHome: null,
    executionHostId: 'local'
  })
  expect(useAppStore.getState().tabsByWorktree[checkoutId]).toBeUndefined()
  const pane = connectHistoryCliPane(useAppStore.getState(), created)
  try {
    await pane.connected
    expect(pane.owner.executionHostId).toBe('local')
    expect(window.api.pty.spawn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        worktreeId: bareId,
        cwd: '/physical/storage/src',
        command: expect.stringContaining('provider-original'),
        resumeProviderSession: { key: 'session_id', id: 'provider-original' }
      })
    )
  } finally {
    pane.transport.destroy?.()
  }
  fireEvent.click(screen.getByRole('button', { name: 'Checkout CLI' }))
  await waitFor(() => expect(useAppStore.getState().tabsByWorktree[checkoutId]).toHaveLength(1))
  expect(useAppStore.getState().tabsByWorktree[checkoutId][0].startupCwd).toBe('/repo/checkout/src')
  expect(useAppStore.getState().tabsByWorktree[bareId]).toEqual([created])
  expect(useAppStore.getState().worktreesByRepo[repo.id]).toEqual([checkout])
})

it.each(['local', 'ssh:target-1'] as const)(
  'dispatches the qualified original CLI to %s while the same workspace id is active on a foreign host',
  async (executionHostId) => {
    const original = {
      ...session('provider-local-twin', '/repo/.bare/src', 'Local original'),
      executionHostId
    }
    host.sessions = [original]
    installHistoryHostTwin(executionHostId)
    let pane: ReturnType<typeof connectHistoryCliPane> | undefined
    const unsubscribe = useAppStore.subscribe((state) => {
      const tab = state.tabsByWorktree[bareId]?.[0]
      if (tab && !pane) {
        pane = connectHistoryCliPane(state, tab)
      }
    })
    let hostAtDispatch: ReturnType<typeof useAppStore.getState>['activeWorkspaceExecutionHostId'] =
      null
    vi.mocked(window.api.pty.spawn).mockImplementation(async () => {
      hostAtDispatch = useAppStore.getState().activeWorkspaceExecutionHostId
      return { id: 'history-resume-pty' }
    })
    try {
      render(<AiVaultPanel workspace={{ worktreeId: bareId, executionHostId }} />)
      expect(screen.getByRole('button', { name: 'Local original' })).toBeEnabled()
      expect(host.targets[original.id]).toBe(bareId)
      fireEvent.click(screen.getByRole('button', { name: 'Local original' }))
      await waitFor(() => expect(useAppStore.getState().tabsByWorktree[bareId]).toHaveLength(1))
      await pane?.connected
      expect(pane?.owner.unresolved).toBe(false)
      expect(pane?.owner.runtimeEnvironmentId).toBeNull()
      expect(pane?.owner.executionHostId).toBe(executionHostId)
      expect(pane?.transport.getExecutionHostId?.()).toBe(executionHostId)
      expect(window.api.pty.spawn).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          worktreeId: bareId,
          cwd: '/repo/.bare/src',
          command: expect.stringContaining('provider-local-twin'),
          resumeProviderSession: { key: 'session_id', id: 'provider-local-twin' },
          ...(executionHostId === 'local' ? {} : { connectionId: 'target-1' })
        })
      )
      expect(vi.mocked(window.api.pty.spawn).mock.calls[0][0].connectionId).toBe(
        executionHostId === 'local' ? undefined : 'target-1'
      )
      expect(hostAtDispatch).toBe('runtime:other')
      expect(host.call.mock.calls.some(([target]) => target.kind === 'environment')).toBe(false)
      const created = expectHistoryCliStartup(bareId, '/repo/.bare/src', 'provider-local-twin')
      expect(useAppStore.getState().unifiedTabsByWorktree[bareId]).toEqual([
        expect.objectContaining({ entityId: created.id, executionHostId })
      ])
      await waitFor(() =>
        expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe(executionHostId)
      )
      expect(useAppStore.getState().activeWorktreeId).toBe(bareId)
      expect(window.api.aiVault.prepareSessionResume).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
      pane?.transport.destroy?.()
    }
  }
)

it('reopens a closed native record by exact saved locator and host through the real rich opener and inventory owner', async () => {
  const native = {
    ...session('provider-native', '/repo/checkout/src', 'Original native'),
    structuredSession: { workspaceId: bareId, sessionId: nativeId }
  }
  host.sessions = [native]
  // The foreign row shares the exact workspace id/path, without owning this record.
  useAppStore.setState({
    repos: [repo, { ...repo, executionHostId: 'runtime:other' }],
    detectedWorktreesByRepo: {
      [repo.id]: {
        repoId: repo.id,
        source: 'git',
        authoritative: true,
        worktrees: [{ ...bare, hostId: 'runtime:other' }, bare]
      }
    }
  })
  publishStoppedHistoryListing()
  let revealed = false
  host.call.mockImplementation(async (_target, method) => {
    if (method === 'session.tabs.list') {
      return inventory(revealed)
    }
    if (method === 'orchestration.partyLocation') {
      return { location: { kind: 'chat', worktreeId: bareId, sessionId: nativeId } }
    }
    if (method === 'agentSession.reveal') {
      revealed = true
      return { ok: true, workspaceId: bareId, sessionId: nativeId, agent: 'codex' }
    }
    return {}
  })
  expect(useAppStore.getState().unifiedTabsByWorktree[bareId]).toBeUndefined()
  render(<AiVaultPanel workspace={{ worktreeId: bareId, executionHostId: 'local' }} />)
  fireEvent.click(screen.getByRole('radio', { name: /^All$/ }))
  expect(screen.getByRole('button', { name: 'Original native' })).toBeEnabled()
  act(() => {
    const current = selectDetectedWorktreesByRepo(useAppStore.getState())[repo.id]
    expect(
      mergeFetchedWorktrees(useAppStore.setState, useAppStore.getState, {
        repoId: repo.id,
        hostId: 'runtime:other',
        ownerWasMissingAtStart: false,
        requestStartedWorktrees: useAppStore.getState().worktreesByRepo[repo.id],
        refresh: {
          status: 'admitted',
          executionHostId: 'runtime:other',
          result: {
            ...current,
            source: 'git',
            authoritative: true,
            worktrees: [{ ...bare, hostId: 'runtime:other' }]
          }
        }
      })
    ).toBe('applied')
  })
  expect(selectDetectedWorktreesByRepo(useAppStore.getState())[repo.id].authoritative).toBe(true)
  expect(findAiVaultHistoryWorktree(useAppStore.getState(), bareId, 'local')).toMatchObject({
    id: bareId,
    path: bare.path,
    hostId: 'local',
    isBare: false
  })
  expect(screen.getByRole('button', { name: 'Original native' })).toBeEnabled()
  expect(host.targets[native.id]).toBe(bareId)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Original native' }))
  })
  await waitFor(() =>
    expect(useAppStore.getState().activeTabTypeByWorktree[bareId]).toBe('agent-session')
  )
  expect(host.call).toHaveBeenCalledWith({ kind: 'local' }, 'orchestration.partyLocation', {
    address: `orca_session_id:${nativeId}`
  })
  expect(host.call).toHaveBeenCalledWith({ kind: 'local' }, 'agentSession.reveal', {
    sessionId: nativeId
  })
  expect(host.call).toHaveBeenCalledWith({ kind: 'local' }, 'session.tabs.activate', {
    worktree: `id:${bareId}`,
    tabId: `agent-session:${nativeId}`
  })
  expect(host.call.mock.calls.every(([target]) => target.kind === 'local')).toBe(true)
  expect(useAppStore.getState().unifiedTabsByWorktree[bareId]).toEqual([
    expect.objectContaining({
      contentType: 'agent-session',
      entityId: nativeId,
      executionHostId: 'local'
    })
  ])
  expect(useAppStore.getState().tabsByWorktree[checkoutId]).toBeUndefined()
  expect(window.api.aiVault.prepareSessionResume).not.toHaveBeenCalled()
  expect(useAppStore.getState().worktreesByRepo[repo.id]).toEqual([checkout])
})
