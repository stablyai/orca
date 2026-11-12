/** Same repo/path IDs can belong to two hosts; removing remote copy must preserve local shells, tabs and dirty drafts. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerPendingEditorFlush } from '@/components/editor/save/flush/editor-pending-flush'
import { confirmUnsavedDiscard } from '../slices/worktrees/teardown/removed-workspace-unsaved-files'
import { createTestStore } from '../testing/app-store-test-fixture'
import { makeOpenFile } from '../slices/editor/types/open-file.test-fixture'
import { makeTab } from '../terminals/terminal-tab.test-fixture'
import { makeTabGroup, makeUnifiedTab } from '../slices/tabs/tab-group.test-fixture'
import { makeWorktree } from '../slices/worktrees/worktree.test-fixture'
import type { Repo } from '../../../../shared/repo-types'
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
import '../../../../shared/workspace-scope'

const recoveryNotice = vi.hoisted(() => vi.fn())
vi.mock('@/components/editor/closed-unsaved-files-toast', () => ({
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
let onRepoRemoved: (() => void) | null = null

function answerLikeRuntimeHost(args: RuntimeEnvironmentCallRequest): unknown {
  const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
  if (compatible) {
    return compatible
  }
  if (args.method === 'repo.rm') {
    onRepoRemoved?.()
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
            onRepoRemoved?.()
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
  it.each([false, true])(
    'captures twin and exclusive delayed text in one notice (confirmed=%s)',
    async (confirmed) => {
      const store = seedTwins()
      const exclusive = `${PROJECT_ID}::/work/exclusive`
      const exclusiveFile = '/work/exclusive/note.ts'
      store.setState((s) => ({
        worktreesByRepo: {
          [PROJECT_ID]: [
            ...(s.worktreesByRepo[PROJECT_ID] ?? []),
            makeWorktree({ id: exclusive, repoId: PROJECT_ID, hostId: REMOTE_HOST })
          ]
        },
        openFiles: [
          ...s.openFiles,
          makeOpenFile({ id: exclusiveFile, worktreeId: exclusive, runtimeEnvironmentId: 'env-b' })
        ]
      }))
      const flushed: string[] = []
      const unregister = ['editor:remote-file', exclusiveFile].map((id) =>
        registerPendingEditorFlush(id, () => {
          flushed.push(id)
          store.setState((s) => ({ editorDrafts: { ...s.editorDrafts, [id]: `late ${id}` } }))
        })
      )
      try {
        const confirmedDiscards = confirmed
          ? confirmUnsavedDiscard(store.getState, [
              { id: WORKTREE_ID, hostId: REMOTE_HOST },
              { id: exclusive, hostId: REMOTE_HOST }
            ])
          : undefined
        await store.getState().removeProject(PROJECT_ID, { hostId: REMOTE_HOST, confirmedDiscards })
        await layoutApplyTestTransport.settle()
        expect([...new Set(flushed)].sort()).toEqual(['editor:remote-file', exclusiveFile].sort())
        expect(store.getState().editorDrafts['/work/same/local.ts']).toBe('unsaved local edit')
        if (confirmed) {
          await new Promise((resolve) => setTimeout(resolve, 0))
          expect(recoveryNotice).not.toHaveBeenCalled()
        } else {
          await vi.waitFor(() => expect(recoveryNotice).toHaveBeenCalledTimes(1))
          expect(
            recoveryNotice.mock.calls[0]?.[0].map((f: { content: string }) => f.content).sort()
          ).toEqual(['late editor:remote-file', `late ${exclusiveFile}`].sort())
        }
      } finally {
        unregister.forEach((f) => f())
      }
    }
  )

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
    expect(ptyKill).toHaveBeenCalledWith('pty-local')
    expect(ptyKill).not.toHaveBeenCalledWith(remotePtyId)
  })
})
