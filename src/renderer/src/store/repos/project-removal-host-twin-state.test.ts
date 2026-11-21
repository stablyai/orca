/** Same repo/path IDs can belong to two hosts; removing remote copy must preserve local shells, tabs and dirty drafts. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as React from 'react'

import { createTestStore } from '../testing/app-store-test-fixture'
import { makeOpenFile } from '../slices/editor/types/open-file.test-fixture'
import { makeTab } from '../terminals/testing/terminal-tab.test-fixture'
import { makeTabGroup, makeUnifiedTab } from '../slices/tabs/tab-group.test-fixture'
import { makeWorktree } from '../slices/worktrees/worktree.test-fixture'
import {
  admitTerminalNoticeLifetime,
  retireTerminalNoticeLifetime
} from '@/components/terminal-pane/provider-notices/terminal-notice-lifetime'
import type { CodexAccountRestart } from '../terminals/terminal-contracts'
import type { Repo } from '../../../../shared/repository/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { layoutApplyTestTransport } from '@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { ClosedEditorTabSnapshot } from '../slices/editor/types/open-file'
import '../../../../shared/workspace/identity/workspace-scope'
import {
  accountRestartSlotKey,
  hasFreeDetachedRestartSlot,
  holdDetachedRestartSlot,
  resetDetachedRestartSlotsForTests,
  subscribeDetachedRestartCapacity
} from '@/components/terminal-pane/account-restart/detached/detached-pane-restart-slots'
import { continueCodexAccountRestart } from '@/components/terminal-pane/account-restart/codex-account-restart-execution'
import { codexAccountRestartToken } from '../terminals/codex-account-restart-continuation'
import {
  bindPanePtyExit,
  initializePanePtyExit
} from '@/components/terminal-pane/pty-connection/lifecycle/pane-pty-exit'
import type { ConnectPanePtySession } from '@/components/terminal-pane/pty-connection/connect-pane-pty-session'
import { useTerminalPaneLayoutBindings } from '@/components/terminal-pane/layout/ownership/use-terminal-pane-layout-bindings'
import type { TerminalPaneLayoutController } from '@/components/terminal-pane/layout/persistence/use-terminal-pane-layout-persistence'
import { useAppStore } from '@/store'

// Why: the pane exit path and its binding callback read the app store; point it at each seeded store.
const seeded = vi.hoisted((): { store: ReturnType<typeof createTestStore> | null } => ({
  store: null
}))
vi.mock('@/store', () => {
  const current = (): ReturnType<typeof createTestStore> => {
    if (!seeded.store) {
      throw new Error('Seed a store before the app store is read')
    }
    return seeded.store
  }
  return {
    useAppStore: {
      getState: () => current().getState(),
      getInitialState: () => current().getInitialState(),
      setState: (...args: Parameters<ReturnType<typeof createTestStore>['setState']>) =>
        current().setState(...args),
      subscribe: (...args: Parameters<ReturnType<typeof createTestStore>['subscribe']>) =>
        current().subscribe(...args)
    }
  }
})
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  // Why: exercise the real layout-binding callbacks without mounting a pane.
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(create: () => T) => create()
}))
vi.mock('@/runtime/sync-runtime-graph/graph-sync-scheduler', () => ({
  scheduleRuntimeGraphSync: () => {}
}))

const recoveryNotice = vi.hoisted(() => vi.fn())
vi.mock('@/components/editor/model-lifetime/retention/closed-unsaved-files-toast', () => ({
  showClosedUnsavedFilesToast: recoveryNotice
}))

const PROJECT_ID = 'same-repo'
const WORKTREE_ID = 'same-repo::/work/same'
const REMOTE_HOST = 'runtime:env-b' as const
const LOCAL_HOST = 'local'
const localRow: Repo = {
  id: PROJECT_ID,
  path: '/work/same',
  displayName: 'Same',
  badgeColor: '#000',
  addedAt: 1,
  executionHostId: 'local'
}
const remoteRow: Repo = { ...localRow, executionHostId: REMOTE_HOST }
const remotePtyId = toRemoteRuntimePtyId('handle-1', 'env-b')

const ptyKill = vi.fn()
let onRepoRemoved: (() => void | Promise<void>) | null = null

async function answerLikeRuntimeHost(args: RuntimeEnvironmentCallRequest): Promise<unknown> {
  const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
  if (compatible) {
    return compatible
  }
  if (args.method === 'repo.rm') {
    await onRepoRemoved?.()
  }
  return { id: args.method, ok: true, result: {}, _meta: { runtimeId: 'runtime-remote' } }
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  // Main routes twin editor close to its owner, then window cleans its drawn copy.
  layoutApplyTestTransport.reset()
  layoutApplyTestTransport.answerWith({ refuse: 'host_not_owned' })
  ptyKill.mockReset()
  recoveryNotice.mockClear()
  onRepoRemoved = null
  vi.stubGlobal('window', {
    api: {
      repos: {
        remove: vi.fn(),
        removeForHost: vi.fn(async ({ hostId }: { hostId: string }) => {
          if (hostId === LOCAL_HOST) {
            await onRepoRemoved?.()
          }
        })
      },
      pty: { kill: ptyKill },
      runtimeEnvironments: {
        call: vi.fn(answerLikeRuntimeHost),
        list: vi.fn().mockResolvedValue([{ id: 'env-b' }])
      },
      ui: { set: vi.fn().mockResolvedValue(undefined) }
    }
  })
})

function closedSnapshot(filePath: string): ClosedEditorTabSnapshot {
  const {
    id: _id,
    isDirty: _dirty,
    ...snapshot
  } = makeOpenFile({
    id: filePath,
    worktreeId: WORKTREE_ID
  })
  return snapshot
}

function seedTwins(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seeded.store = store
  const localFileId = '/work/same/local.ts'
  const remoteFileId = 'editor:remote-file'
  store.setState({
    repos: [localRow, remoteRow],
    worktreesByRepo: {
      [PROJECT_ID]: [
        makeWorktree({ id: WORKTREE_ID, repoId: PROJECT_ID, hostId: 'local' }),
        makeWorktree({ id: WORKTREE_ID, repoId: PROJECT_ID, hostId: REMOTE_HOST })
      ]
    },
    tabsByWorktree: {
      [WORKTREE_ID]: [
        makeTab({ id: 'tab-local', worktreeId: WORKTREE_ID, ptyId: 'pty-local' }),
        makeTab({ id: 'tab-remote', worktreeId: WORKTREE_ID, ptyId: remotePtyId })
      ]
    },
    ptyIdsByTabId: { 'tab-local': ['pty-local'], 'tab-remote': [remotePtyId] },
    unifiedTabsByWorktree: {
      [WORKTREE_ID]: [
        makeUnifiedTab({
          id: 'tab-local',
          worktreeId: WORKTREE_ID,
          groupId: 'group-1',
          executionHostId: 'local'
        }),
        makeUnifiedTab({
          id: 'tab-remote',
          worktreeId: WORKTREE_ID,
          groupId: 'group-1',
          executionHostId: REMOTE_HOST
        }),
        makeUnifiedTab({
          id: localFileId,
          worktreeId: WORKTREE_ID,
          groupId: 'group-1',
          contentType: 'editor',
          executionHostId: 'local'
        }),
        // Stamped with the focused twin, but the file itself names the remote host.
        makeUnifiedTab({
          id: remoteFileId,
          worktreeId: WORKTREE_ID,
          groupId: 'group-1',
          contentType: 'editor',
          executionHostId: 'local'
        })
      ]
    },
    groupsByWorktree: {
      [WORKTREE_ID]: [
        makeTabGroup({
          id: 'group-1',
          worktreeId: WORKTREE_ID,
          activeTabId: 'tab-local',
          tabOrder: ['tab-local', 'tab-remote', localFileId, remoteFileId]
        })
      ]
    },
    openFiles: [
      makeOpenFile({ id: localFileId, worktreeId: WORKTREE_ID, isDirty: true }),
      makeOpenFile({
        id: remoteFileId,
        filePath: '/work/same/remote.ts',
        worktreeId: WORKTREE_ID,
        runtimeEnvironmentId: 'env-b',
        isDirty: true
      })
    ],
    editorDrafts: { [localFileId]: 'unsaved local edit', [remoteFileId]: 'unsaved remote edit' },
    recentlyClosedEditorTabsByWorktree: {
      [WORKTREE_ID]: [
        { ...closedSnapshot('/work/same/old-remote.ts'), runtimeEnvironmentId: 'env-b' },
        closedSnapshot('/work/same/old-local.ts')
      ]
    },
    recentlyClosedTabKindsByWorktree: { [WORKTREE_ID]: ['editor', 'browser', 'editor'] }
  })
  return store
}

describe('removing a remote project keeps its local twin', () => {
  it('keeps a tab that gained a surviving pane during removal and stops its removed pane', async () => {
    const store = seedTwins()
    store.setState((s) => ({
      unifiedTabsByWorktree: {
        [WORKTREE_ID]: (s.unifiedTabsByWorktree[WORKTREE_ID] ?? []).filter(
          (tab) => tab.id !== 'tab-remote'
        )
      },
      tabsByWorktree: {
        [WORKTREE_ID]: (s.tabsByWorktree[WORKTREE_ID] ?? []).filter(
          (tab) => tab.id !== 'tab-remote'
        )
      }
    }))
    onRepoRemoved = () =>
      store.setState((s) => ({
        ptyIdsByTabId: { ...s.ptyIdsByTabId, 'tab-local': ['pty-local', remotePtyId] }
      }))

    await store.getState().removeProject(PROJECT_ID, { hostId: 'local' })

    expect(store.getState().tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      'tab-local'
    ])
  })
  it.each([LOCAL_HOST, REMOTE_HOST] as const)(
    'retires only the removed %s restart in a surviving mixed tab',
    async (hostId) => {
      const store = seedTwins()
      const tab = store.getState().tabsByWorktree[WORKTREE_ID][0]
      const request = (host: 'local' | 'runtime:env-b', ptyId: string): CodexAccountRestart => ({
        agent: 'codex',
        requestId: `request-${host}`,
        attemptId: `attempt-${host}`,
        executorId: `executor-${host}`,
        worktreeId: WORKTREE_ID,
        tabId: tab.id,
        tabCreatedAt: tab.createdAt,
        leafId: null,
        oldPtyId: ptyId,
        hostId: host,
        environmentId: host === LOCAL_HOST ? null : 'env-b',
        phase: 'claimed',
        startup: null,
        startupInput: null
      })
      const local = request(LOCAL_HOST, 'pty-local')
      const remote = request(REMOTE_HOST, remotePtyId)
      const notices = {
        'pty-local': { previousAccountLabel: 'old', nextAccountLabel: 'new' },
        [remotePtyId]: { previousAccountLabel: 'old', nextAccountLabel: 'new' }
      }
      store.setState((state) => ({
        tabsByWorktree: { [WORKTREE_ID]: [tab] },
        unifiedTabsByWorktree: {
          [WORKTREE_ID]: state.unifiedTabsByWorktree[WORKTREE_ID].filter(
            (row) => row.id !== 'tab-remote'
          )
        },
        ptyIdsByTabId: { [tab.id]: ['pty-local', remotePtyId] },
        pendingPaneAccountRestarts: { local, remote },
        codexRestartNoticeByPtyId: notices
      }))
      await store.getState().removeProject(PROJECT_ID, { hostId })
      const state = store.getState()
      expect(state.tabsByWorktree[WORKTREE_ID]?.map((row) => row.id)).toEqual(['tab-local'])
      if (hostId === LOCAL_HOST) {
        expect(state.pendingPaneAccountRestarts).toEqual({ remote })
        expect(state.pendingPaneAccountRestarts.remote).toBe(remote)
        expect(state.codexRestartNoticeByPtyId).toEqual({ [remotePtyId]: notices[remotePtyId] })
        expect(ptyKill).toHaveBeenCalledWith('pty-local')
      } else {
        expect(state.pendingPaneAccountRestarts).toEqual({ local })
        expect(state.pendingPaneAccountRestarts.local).toBe(local)
        expect(state.codexRestartNoticeByPtyId).toEqual({ 'pty-local': notices['pty-local'] })
        expect(ptyKill).not.toHaveBeenCalled()
      }
    }
  )
})

describe('a removed-host restart whose pane changes while removal awaits', () => {
  const leaf = '00000000-0000-4000-8000-000000000011'
  const survivorLeaf = '00000000-0000-4000-8000-000000000012'
  let stopListening: () => void = () => {}
  afterEach(() => {
    stopListening()
    resetDetachedRestartSlotsForTests()
  })

  /** The real pane exit handler and layout-binding callback for a confirmed exit of a visible newborn split. */
  function confirmPaneExit(tabId: string, ptyId: string, runtimeEnvironmentId: string | null) {
    const panes = [
      { id: 1, leafId: leaf },
      { id: 2, leafId: survivorLeaf }
    ]
    const manager = {
      getPanes: () => panes,
      getLeafId: (id: number) => panes.find((pane) => pane.id === id)?.leafId ?? null,
      getActivePane: () => panes[0],
      getNumericIdForLeaf: (leafId: string) => panes.find((p) => p.leafId === leafId)?.id ?? null,
      setActivePane: vi.fn(),
      setPaneGpuRendering: vi.fn(),
      closePane: vi.fn()
    }
    const transport = { getPtyId: () => ptyId }
    const paneTransportsRef = { current: new Map([[1, transport]]) }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the exit path reads only tabId, managerRef, paneTransportsRef and setTabLayout.
    const controller = {
      tabId,
      managerRef: { current: manager },
      paneTransportsRef,
      setTabLayout: useAppStore.getState().setTabLayout
    } as unknown as TerminalPaneLayoutController
    // oxlint-disable-next-line react-hooks/rules-of-hooks -- React registration is mocked; this is the real binding callback.
    const bindings = useTerminalPaneLayoutBindings(controller)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connectPanePty builds the session the same partial way before binding exit.
    const session = {
      pane: { id: 1, leafId: leaf },
      manager,
      transport,
      deps: {
        tabId,
        paneTransportsRef,
        isVisibleRef: { current: true },
        isActiveRef: { current: true },
        onPtyExitRef: { current: vi.fn() },
        isPtyShutdownPending: () => false,
        consumeSuppressedPtyExit: useAppStore.getState().consumeSuppressedPtyExit,
        clearTabPtyId: useAppStore.getState().clearTabPtyId,
        clearRuntimePaneTitle: vi.fn(),
        setCacheTimerStartedAt: vi.fn()
      },
      cacheKey: `${tabId}:${leaf}`,
      runtimeEnvironmentId,
      processExitStateByPtyId: new Map(),
      resetRendererOrderedSeqForPtyExit: () => {},
      agentCompletionCoordinator: { dispose: () => {} },
      dropSideEffectFactConsumer: () => {},
      releaseHiddenRendererPtyDelivery: () => {},
      clearPanePtyFitBinding: () => {},
      clearExitedPanePtyLayoutBinding: (exitedPtyId: string) =>
        bindings.clearExitedPanePtyLayoutBindingForLeaf(leaf, exitedPtyId),
      hadExistingPaneTransportAtConnect: true,
      restoredPtyIdForTransport: null,
      hasReceivedPtyOutput: false,
      lastTerminalInputAt: Number.NEGATIVE_INFINITY,
      isNativeWindowsConpty: false
    } as unknown as ConnectPanePtySession
    initializePanePtyExit(session)
    bindPanePtyExit(session)
    session.onExit(ptyId, 0)
    expect(manager.closePane).not.toHaveBeenCalled()
  }

  it.each([
    [LOCAL_HOST, 'stable'],
    [REMOTE_HOST, 'stable'],
    [LOCAL_HOST, 'exit'],
    [REMOTE_HOST, 'exit'],
    [LOCAL_HOST, 'unbound reply'],
    [REMOTE_HOST, 'unbound reply'],
    [LOCAL_HOST, 'bound reply'],
    [REMOTE_HOST, 'bound reply'],
    [LOCAL_HOST, 'successor'],
    [REMOTE_HOST, 'successor']
  ] as const)('%s removal frees only the captured slot after a %s', async (hostId, change) => {
    const store = seedTwins()
    const tab = store.getState().tabsByWorktree[WORKTREE_ID][0]
    const oldPtyId = hostId === LOCAL_HOST ? 'pty-local' : remotePtyId
    const otherPtyId = hostId === LOCAL_HOST ? remotePtyId : 'pty-local'
    const resultPtyId = hostId === LOCAL_HOST ? 'pty-result' : 'remote:env-b@@handle-result'
    const key = `${tab.id}:${leaf}`
    const restart = (
      host: typeof hostId,
      ptyId: string,
      leafId: string,
      id: string
    ): CodexAccountRestart => ({
      agent: 'codex',
      requestId: `${id}-request`,
      attemptId: `${id}-attempt`,
      executorId: `${id}-executor`,
      worktreeId: WORKTREE_ID,
      tabId: tab.id,
      tabCreatedAt: tab.createdAt,
      leafId,
      oldPtyId: ptyId,
      hostId: host,
      environmentId: host === LOCAL_HOST ? null : 'env-b',
      phase: 'claimed',
      startup: null,
      startupInput: null
    })
    const request = restart(hostId, oldPtyId, leaf, 'removed')
    const notice = { previousAccountLabel: 'old', nextAccountLabel: 'new' }
    // Another project on the removed host whose ended endpoints' IDs the relay reused here.
    const protectedWorktreeId = 'protected-repo::/work/protected'
    const protectedTab = makeTab({
      id: 'protected-tab',
      worktreeId: protectedWorktreeId,
      ptyId: 'protected-successor'
    })
    const protectedKey = `${protectedTab.id}:${leaf}`
    const recycled: CodexAccountRestart = {
      ...restart(hostId, oldPtyId, leaf, 'protected'),
      worktreeId: protectedWorktreeId,
      tabId: protectedTab.id,
      tabCreatedAt: protectedTab.createdAt,
      resultPtyId,
      resultIncarnationId: 'foreign-incarnation',
      phase: 'unresolved'
    }
    store.setState((state): Partial<ReturnType<typeof store.getState>> => ({
      repos: [...state.repos, { ...localRow, id: 'protected-repo', executionHostId: hostId }],
      worktreesByRepo: {
        ...state.worktreesByRepo,
        'protected-repo': [
          makeWorktree({ id: protectedWorktreeId, repoId: 'protected-repo', hostId })
        ]
      },
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: hostId,
      tabsByWorktree: { [WORKTREE_ID]: [tab], [protectedWorktreeId]: [protectedTab] },
      unifiedTabsByWorktree: {
        [WORKTREE_ID]: state.unifiedTabsByWorktree[WORKTREE_ID].filter(
          (row) => row.id !== 'tab-remote'
        )
      },
      ptyIdsByTabId: {
        [tab.id]: [oldPtyId, otherPtyId],
        [protectedTab.id]: ['protected-successor']
      },
      terminalLayoutsByTabId: {
        [tab.id]: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: leaf },
            second: { type: 'leaf', leafId: survivorLeaf }
          },
          activeLeafId: leaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leaf]: oldPtyId, [survivorLeaf]: otherPtyId }
        },
        [protectedTab.id]: {
          root: { type: 'leaf', leafId: leaf },
          activeLeafId: leaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leaf]: 'protected-successor' }
        }
      },
      pendingPaneAccountRestarts: {
        [key]: request,
        [protectedKey]: recycled
      },
      codexRestartNoticeByPtyId: { [otherPtyId]: notice }
    }))
    // The pool is full: this attempt, two foreign tokens on its pane and the other project's attempt.
    for (const held of [
      request,
      { ...request, attemptId: 'foreign-attempt' },
      { ...request, executorId: 'foreign-executor' }
    ]) {
      holdDetachedRestartSlot(accountRestartSlotKey(key, held), () => {})
    }
    holdDetachedRestartSlot(accountRestartSlotKey(protectedKey, recycled), () => {})
    expect(hasFreeDetachedRestartSlot()).toBe(false)
    let wakes = 0
    stopListening = subscribeDetachedRestartCapacity(() => {
      wakes += 1
    })
    const token = codexAccountRestartToken(request)
    const successor = restart(hostId, oldPtyId, leaf, 'successor')
    let resume!: () => void
    let entered!: () => void
    const held = new Promise<void>((resolve) => {
      resume = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    onRepoRemoved = async () => {
      entered()
      await held
    }
    const removal = store.getState().removeProject(PROJECT_ID, { hostId })
    let resultLifetime: ReturnType<typeof admitTerminalNoticeLifetime> | undefined
    try {
      await Promise.race([
        started,
        removal.then(() => {
          throw new Error('Removal finished before reaching the held host call')
        })
      ])
      if (change !== 'stable') {
        confirmPaneExit(tab.id, oldPtyId, hostId === LOCAL_HOST ? null : 'env-b')
        const { root, ptyIdsByLeafId } = store.getState().terminalLayoutsByTabId[tab.id]
        expect(root).toMatchObject({ first: { leafId: leaf }, second: { leafId: survivorLeaf } })
        expect(ptyIdsByLeafId).toEqual({ [survivorLeaf]: otherPtyId })
        expect(store.getState().ptyIdsByTabId[tab.id]).toEqual([otherPtyId])
        expect(store.getState().pendingPaneAccountRestarts[key]).toBe(request)
      }
      if (change === 'unbound reply') {
        expect(continueCodexAccountRestart(token, { id: resultPtyId })).toBe(false)
        expect(store.getState().pendingPaneAccountRestarts[key]).toMatchObject({
          resultPtyId,
          phase: 'unresolved'
        })
      }
      if (change === 'bound reply') {
        resultLifetime = admitTerminalNoticeLifetime(resultPtyId, {
          incarnationId: 'result-1',
          fresh: true
        })
        expect(
          continueCodexAccountRestart(token, { id: resultPtyId, incarnationId: 'result-1' })
        ).toBe(true)
        store.getState().updateTabPtyId(tab.id, resultPtyId)
        const layout = store.getState().terminalLayoutsByTabId[tab.id]
        store.getState().setTabLayout(tab.id, {
          ...layout,
          ptyIdsByLeafId: { ...layout.ptyIdsByLeafId, [leaf]: resultPtyId }
        })
        expect(store.getState().pendingPaneAccountRestarts[key]).toMatchObject({ resultPtyId })
      }
      if (change === 'successor') {
        store.getState().updateCodexAccountRestart(token, null)
        store.setState((state) => ({
          pendingPaneAccountRestarts: { ...state.pendingPaneAccountRestarts, [key]: successor }
        }))
        holdDetachedRestartSlot(accountRestartSlotKey(key, successor), () => {})
      }
    } finally {
      resume()
      await removal
      if (resultLifetime) {
        retireTerminalNoticeLifetime(resultLifetime)
      }
    }
    const state = store.getState()
    expect(state.pendingPaneAccountRestarts).toEqual({
      ...(change === 'successor' ? { [key]: successor } : {}),
      [protectedKey]: recycled
    })
    expect(state.pendingPaneAccountRestarts[protectedKey]).toBe(recycled)
    // The surviving host's pane, binding and notice stay with the mixed tab.
    expect(state.tabsByWorktree[WORKTREE_ID]?.map((row) => row.id)).toEqual([tab.id])
    expect(state.terminalLayoutsByTabId[tab.id].ptyIdsByLeafId?.[survivorLeaf]).toBe(otherPtyId)
    expect(state.ptyIdsByTabId[tab.id]).toContain(otherPtyId)
    expect(state.codexRestartNoticeByPtyId).toEqual({ [otherPtyId]: notice })
    // Exactly one slot was freed and woke the scheduler; the foreign tokens and other project keep theirs.
    expect(wakes).toBe(1)
    if (change !== 'successor') {
      expect(hasFreeDetachedRestartSlot()).toBe(true)
      holdDetachedRestartSlot('waiting-entry', () => {})
    }
    expect(hasFreeDetachedRestartSlot()).toBe(false)
    const killed: Record<string, string[]> = { stable: [oldPtyId], 'bound reply': [resultPtyId] }
    expect(ptyKill.mock.calls).toEqual(
      (hostId === LOCAL_HOST ? (killed[change] ?? []) : []).map((ptyId) => [ptyId])
    )
  })
})
