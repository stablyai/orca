import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../../types'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import {
  applyDiffCommentWrite,
  type DiffCommentBaseMutation
} from '../../../../../shared/file-review/diff-comment-mutation'
import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache } from '../../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { clearRuntimeEnvironmentConnectionGenerations } from '../runtime-status/runtime-status-connection-generation'
import { createDiffCommentsSlice } from './create-diff-comments-slice'
import { selectDiffCommentView, type DiffCommentOwner } from './diff-comment-owner'
import {
  makeFolderWorkspace,
  makeProjectGroup
} from '@/components/sidebar/workspace-creation/folder/folder-workspace-composer-submit-fixtures'

const folderWorkspacesUpdate = vi.fn()
const folderWorkspacesList = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

vi.stubGlobal('window', {
  api: {
    folderWorkspaces: { update: folderWorkspacesUpdate, list: folderWorkspacesList },
    runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
  }
})

type FolderUpdates = { diffComments?: DiffComment[] } & DiffCommentBaseMutation

function folderUpdatesOf(params: RuntimeEnvironmentCallRequest['params']): FolderUpdates {
  const updates = params?.updates
  if (typeof updates !== 'object' || updates === null) {
    throw new Error('folderWorkspace.update without updates')
  }
  return updates
}

/** One host's catalog row: it merges each write the way the real host does. */
function createHost(row: FolderWorkspace) {
  const host = {
    row,
    // The next write lands on the host, but its answer never reaches the client.
    dropNextAck: false,
    apply(updates: FolderUpdates): FolderWorkspace {
      host.row = {
        ...host.row,
        diffComments: applyDiffCommentWrite(host.row.diffComments, updates)
      }
      if (host.dropNextAck) {
        host.dropNextAck = false
        throw new Error('connection lost')
      }
      return host.row
    }
  }
  return host
}

function createTestStore() {
  return create<AppState>()((...args) => {
    const slice = createDiffCommentsSlice(...args)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial store with only the fields review-note owners and writes read.
    return {
      ...slice,
      settings: null,
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      folderWorkspaces: [],
      projectGroups: [],
      repos: [],
      runtimeEnvironments: [],
      restoredRuntimeHostIdByWorkspaceSessionKey: {},
      worktreesByRepo: {}
    } as unknown as AppState
  })
}

function ownerOf(store: { getState: () => AppState }, worktreeId: string): DiffCommentOwner {
  const owner = selectDiffCommentView(store.getState(), worktreeId, 'selection').owner
  if (!owner) {
    throw new Error('test folder is not resolvable')
  }
  return owner
}

function peerNote(): DiffComment {
  return {
    id: 'peer-note',
    worktreeId: folderWorkspaceKey('folder-1'),
    filePath: 'README.md',
    source: 'markdown',
    lineNumber: 2,
    body: 'saved on another device',
    side: 'modified',
    createdAt: 1
  }
}

function rpcReply(result: unknown) {
  return { id: 'rpc', ok: true, result, _meta: { runtimeId: 'remote-runtime' } }
}

const HOSTS = [
  { name: 'this computer', hostId: 'local', runtimeEnvironmentId: null },
  { name: 'a paired server', hostId: 'runtime:env-owner', runtimeEnvironmentId: 'env-owner' }
] as const

describe('folder review notes after a failed save', () => {
  let errSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCache()
    clearRuntimeEnvironmentConnectionGenerations()
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
    })
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errSpy.mockRestore()
  })

  it.each(HOSTS)(
    "keeps another device's note when a retry follows a save that landed unacknowledged ($name)",
    async ({ hostId, runtimeEnvironmentId }) => {
      const workspaceKey = folderWorkspaceKey('folder-1')
      const row = makeFolderWorkspace({
        id: 'folder-1',
        folderPath: '/workspace',
        ...(runtimeEnvironmentId ? {} : { executionHostId: 'local' }),
        diffComments: []
      })
      const host = createHost(row)
      if (runtimeEnvironmentId) {
        runtimeEnvironmentCall.mockImplementation(async (args: RuntimeEnvironmentCallRequest) => {
          if (args.method === 'folderWorkspace.list') {
            return rpcReply({ folderWorkspaces: [host.row] })
          }
          if (args.method === 'folderWorkspace.update') {
            return rpcReply({ folderWorkspace: host.apply(folderUpdatesOf(args.params)) })
          }
          throw new Error(`unexpected ${args.method}`)
        })
      } else {
        folderWorkspacesUpdate.mockImplementation(async ({ updates }) => host.apply(updates))
        folderWorkspacesList.mockImplementation(async () => [host.row])
      }
      const store = createTestStore()
      store.setState({
        activeWorktreeId: workspaceKey,
        activeWorkspaceExecutionHostId: hostId,
        projectGroups: [
          {
            ...makeProjectGroup(),
            parentPath: '/workspace',
            executionHostId: hostId,
            ...(runtimeEnvironmentId ? { connectionId: 'box' } : {})
          }
        ],
        folderWorkspaces: [row]
      })

      host.dropNextAck = true
      const added = await store.getState().addDiffComment(ownerOf(store, workspaceKey), {
        worktreeId: workspaceKey,
        filePath: 'README.md',
        source: 'markdown',
        lineNumber: 1,
        body: 'my note',
        side: 'modified'
      })
      // The save is reported as failed even though the host kept it.
      expect(added).toBeNull()
      const mine = host.row.diffComments?.[0]
      expect(mine?.body).toBe('my note')

      host.row = { ...host.row, diffComments: [...(host.row.diffComments ?? []), peerNote()] }

      // The user writes the note again; the retry must not replace the host's list.
      const retried = await store.getState().addDiffComment(ownerOf(store, workspaceKey), {
        worktreeId: workspaceKey,
        filePath: 'README.md',
        source: 'markdown',
        lineNumber: 1,
        body: 'my note again',
        side: 'modified'
      })
      expect(retried).not.toBeNull()
      // This copy's own notes converge to what it shows (the failed one was rolled back);
      // the note it never listed is another device's and stays.
      expect(host.row.diffComments?.map((note) => note.body)).toEqual([
        'saved on another device',
        'my note again'
      ])
      expect(
        store
          .getState()
          .getDiffComments(workspaceKey)
          .map((note) => note.body)
      ).toEqual(['my note again'])
    }
  )
})
