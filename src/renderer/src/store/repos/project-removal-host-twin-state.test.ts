/** Same repo/path IDs can belong to two hosts; removing remote copy must preserve local shells, tabs and dirty drafts. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createTestStore } from '../testing/app-store-test-fixture'
import { makeOpenFile } from '../slices/editor/types/open-file.test-fixture'
import { makeTab } from '../terminals/testing/terminal-tab.test-fixture'
import { makeTabGroup, makeUnifiedTab } from '../slices/tabs/tab-group.test-fixture'
import { makeWorktree } from '../slices/worktrees/worktree.test-fixture'
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
  it.each([LOCAL_HOST, REMOTE_HOST] as const)(
    'retires the captured %s intent after its binding exits during removal',
    async (hostId) => {
      const store = seedTwins()
      const tab = store.getState().tabsByWorktree[WORKTREE_ID][0]
      const leaf = '00000000-0000-4000-8000-000000000011'
      const survivor = '00000000-0000-4000-8000-000000000012'
      const oldPtyId = hostId === LOCAL_HOST ? 'pty-local' : remotePtyId
      const otherPtyId = hostId === LOCAL_HOST ? remotePtyId : 'pty-local'
      const key = `${tab.id}:${leaf}`
      const request: CodexAccountRestart = {
        agent: 'codex',
        requestId: 'removed-request',
        attemptId: 'removed-attempt',
        executorId: 'removed-executor',
        worktreeId: WORKTREE_ID,
        tabId: tab.id,
        tabCreatedAt: tab.createdAt,
        leafId: leaf,
        oldPtyId,
        hostId,
        environmentId: hostId === LOCAL_HOST ? null : 'env-b',
        phase: 'claimed',
        startup: null,
        startupInput: null
      }
      store.setState((state) => ({
        activeWorktreeId: WORKTREE_ID,
        activeWorkspaceExecutionHostId: hostId,
        tabsByWorktree: { [WORKTREE_ID]: [tab] },
        unifiedTabsByWorktree: {
          [WORKTREE_ID]: state.unifiedTabsByWorktree[WORKTREE_ID].filter(
            (row) => row.id !== 'tab-remote'
          )
        },
        ptyIdsByTabId: { [tab.id]: [oldPtyId, otherPtyId] },
        terminalLayoutsByTabId: {
          [tab.id]: {
            root: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', leafId: leaf },
              second: { type: 'leaf', leafId: survivor }
            },
            activeLeafId: leaf,
            expandedLeafId: null,
            ptyIdsByLeafId: { [leaf]: oldPtyId, [survivor]: otherPtyId }
          }
        },
        pendingPaneAccountRestarts: { [key]: request }
      }))
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
      await started
      const layout = store.getState().terminalLayoutsByTabId[tab.id]
      store
        .getState()
        .setTabLayout(tab.id, { ...layout, ptyIdsByLeafId: { [survivor]: otherPtyId } })
      store.getState().clearTabPtyId(tab.id, oldPtyId)
      expect(store.getState().pendingPaneAccountRestarts[key]).toBe(request)
      expect(store.getState().terminalLayoutsByTabId[tab.id].ptyIdsByLeafId?.[leaf]).toBeUndefined()
      resume()
      await removal
      expect(store.getState().pendingPaneAccountRestarts[key]).toBeUndefined()
      expect(store.getState().ptyIdsByTabId[tab.id]).toEqual([otherPtyId])
      expect(ptyKill).not.toHaveBeenCalled()
    }
  )
})
