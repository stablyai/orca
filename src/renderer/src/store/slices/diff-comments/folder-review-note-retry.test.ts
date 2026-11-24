import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../../types'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import {
  applyDiffCommentWrite,
  type DiffCommentBaseMutation
} from '../../../../../shared/file-review/diff-comment-mutation'
import {
  applyDiffCommentRecovery,
  type DiffCommentRecoveryMutation
} from '../../../../../shared/file-review/diff-comment-recovery'
import { FOLDER_WORKSPACE_DIFF_COMMENT_RECOVERY_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/worktree-runtime-capabilities'
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

type FolderUpdates = { diffComments?: DiffComment[] } & DiffCommentBaseMutation &
  DiffCommentRecoveryMutation

function folderUpdatesOf(params: RuntimeEnvironmentCallRequest['params']): FolderUpdates {
  const updates = params?.updates
  if (typeof updates !== 'object' || updates === null) {
    throw new Error('folderWorkspace.update without updates')
  }
  return updates
}

const WORKSPACE_KEY = folderWorkspaceKey('folder-1')

function note(id: string, body: string, lineNumber = 1): DiffComment {
  return {
    id,
    worktreeId: WORKSPACE_KEY,
    filePath: 'README.md',
    source: 'markdown',
    lineNumber,
    body,
    side: 'modified',
    createdAt: 1
  }
}

/** One host's catalog row: it applies each write the way the real host's folder update does. */
function createHost(row: FolderWorkspace, { merges }: { merges: boolean }) {
  const host = {
    row,
    // The next write lands on the host, but its answer never reaches the client.
    dropNextAck: false,
    // The next write never reaches the host.
    refuseNext: false,
    apply(updates: FolderUpdates): FolderWorkspace {
      if (host.refuseNext) {
        host.refuseNext = false
        throw new Error('host unreachable')
      }
      if (updates.diffComments !== undefined) {
        host.row = {
          ...host.row,
          // An older server takes the list as sent: it knows neither a base nor a recovery.
          diffComments: !merges
            ? updates.diffComments
            : updates.diffCommentsRecovery
              ? applyDiffCommentRecovery(
                  host.row.diffComments ?? [],
                  updates.diffComments,
                  updates.diffCommentsRecovery
                )
              : applyDiffCommentWrite(host.row.diffComments, updates)
        }
      }
      if (host.dropNextAck) {
        host.dropNextAck = false
        throw new Error('connection lost')
      }
      return host.row
    },
    /** Another device's save, merged the same way. */
    peerEdit(edit: (notes: DiffComment[]) => DiffComment[]): void {
      const current = host.row.diffComments ?? []
      host.row = {
        ...host.row,
        diffComments: applyDiffCommentWrite(current, {
          diffComments: edit(current),
          diffCommentsBase: current
        })
      }
    },
    /** Ids and values the host holds, in its order. */
    notes(): { id: string; body: string }[] {
      return (host.row.diffComments ?? []).map(({ id, body }) => ({ id, body }))
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

function rpcReply(result: unknown) {
  return { id: 'rpc', ok: true, result, _meta: { runtimeId: 'remote-runtime' } }
}

type HostCase = {
  hostId: 'local' | 'runtime:env-owner'
  runtimeEnvironmentId: string | null
  merges: boolean
}

const LOCAL: HostCase = { hostId: 'local', runtimeEnvironmentId: null, merges: true }
const PAIRED: HostCase = {
  hostId: 'runtime:env-owner',
  runtimeEnvironmentId: 'env-owner',
  merges: true
}
const OLDER_PAIRED: HostCase = { ...PAIRED, merges: false }

/** This copy and its host, both starting from the same saved notes. */
function setup({ hostId, runtimeEnvironmentId, merges }: HostCase, saved: DiffComment[] = []) {
  const row = makeFolderWorkspace({
    id: 'folder-1',
    folderPath: '/workspace',
    ...(runtimeEnvironmentId ? {} : { executionHostId: 'local' }),
    diffComments: saved
  })
  const host = createHost(row, { merges })
  if (runtimeEnvironmentId) {
    if (!merges) {
      // An older server does not advertise the recovery.
      runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
        const status = createCompatibleRuntimeStatusResponseIfNeeded(args)
        if (!status?.ok) {
          return status ?? runtimeEnvironmentCall(args)
        }
        const capabilities = status.result.capabilities?.filter(
          (entry) => entry !== FOLDER_WORKSPACE_DIFF_COMMENT_RECOVERY_RUNTIME_CAPABILITY
        )
        return { ...status, result: { ...status.result, capabilities } }
      })
    }
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
    activeWorktreeId: WORKSPACE_KEY,
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
  const owner = (): DiffCommentOwner => {
    const found = selectDiffCommentView(store.getState(), WORKSPACE_KEY, 'selection').owner
    if (!found) {
      throw new Error('test folder is not resolvable')
    }
    return found
  }
  const add = (body: string, lineNumber = 1) =>
    store.getState().addDiffComment(owner(), {
      worktreeId: WORKSPACE_KEY,
      filePath: 'README.md',
      source: 'markdown',
      lineNumber,
      body,
      side: 'modified'
    })
  const edit = (id: string, body: string) => store.getState().updateDiffComment(owner(), id, body)
  const shown = () =>
    store
      .getState()
      .getDiffComments(WORKSPACE_KEY)
      .map((entry) => entry.body)
  return { host, add, edit, shown }
}

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

  const CURRENT_HOSTS = [
    ['this computer', LOCAL],
    ['a paired server', PAIRED]
  ] as const

  it.each(CURRENT_HOSTS)(
    'keeps a note another device added after a save that landed unacknowledged (%s)',
    async (_name, hostCase) => {
      const { host, add, shown } = setup(hostCase)
      host.dropNextAck = true
      // The save is reported as failed even though the host kept it.
      expect(await add('my note')).toBeNull()
      expect(host.notes()).toEqual([{ id: expect.any(String), body: 'my note' }])

      host.peerEdit((notes) => [...notes, note('peer', 'from another device', 2)])
      expect(await add('my note again')).not.toBeNull()

      // This copy's own notes converge to what it shows (the failed one was rolled back, and the
      // host still held exactly the version it sent); the note it never listed stays.
      expect(host.notes()).toEqual([
        { id: 'peer', body: 'from another device' },
        { id: expect.any(String), body: 'my note again' }
      ])
      expect(shown()).toEqual(['my note again'])
    }
  )

  it('refuses the save after a failure on an older paired server, sending nothing', async () => {
    const { host, add } = setup(OLDER_PAIRED)
    host.dropNextAck = true
    expect(await add('my note')).toBeNull()
    host.peerEdit((notes) => [...notes, note('peer', 'from another device', 2)])
    const before = host.notes()
    const updatesBefore = runtimeEnvironmentCall.mock.calls.length

    expect(await add('my note again')).toBeNull()

    // That host would replace the list, so nothing is written and the other device's note stays.
    expect(host.notes()).toEqual(before)
    expect(host.notes()).toContainEqual({ id: 'peer', body: 'from another device' })
    expect(runtimeEnvironmentCall.mock.calls.length).toBe(updatesBefore)
  })

  it.each(CURRENT_HOSTS)(
    "keeps another device's edit to a note this copy still shows unchanged (%s)",
    async (_name, hostCase) => {
      const { host, add } = setup(hostCase, [note('x', 'v1')])
      host.refuseNext = true
      expect(await add('unrelated')).toBeNull()
      // Refused before it reached the host: nothing changed there.
      expect(host.notes()).toEqual([{ id: 'x', body: 'v1' }])

      host.peerEdit((notes) => notes.map((entry) => ({ ...entry, body: 'v2 from another device' })))
      expect(await add('mine', 3)).not.toBeNull()

      expect(host.notes()).toEqual([
        { id: 'x', body: 'v2 from another device' },
        { id: expect.any(String), body: 'mine' }
      ])
    }
  )

  it.each(CURRENT_HOSTS)(
    'does not bring back a note another device deleted while this copy still shows it (%s)',
    async (_name, hostCase) => {
      const { host, add } = setup(hostCase, [note('x', 'v1')])
      host.refuseNext = true
      expect(await add('unrelated')).toBeNull()
      expect(host.notes()).toEqual([{ id: 'x', body: 'v1' }])

      host.peerEdit(() => [])
      expect(await add('mine', 3)).not.toBeNull()

      expect(host.notes()).toEqual([{ id: expect.any(String), body: 'mine' }])
      expect(host.notes()[0].id).not.toBe('x')
    }
  )

  it.each(CURRENT_HOSTS)(
    "keeps another device's edit to a note whose save landed unacknowledged (%s)",
    async (_name, hostCase) => {
      const { host, add } = setup(hostCase)
      host.dropNextAck = true
      expect(await add('landed')).toBeNull()
      const [landed] = host.notes()
      expect(landed.body).toBe('landed')

      host.peerEdit((notes) => notes.map((entry) => ({ ...entry, body: 'edited elsewhere' })))
      expect(await add('mine', 3)).not.toBeNull()

      expect(host.notes()).toEqual([
        { id: landed.id, body: 'edited elsewhere' },
        { id: expect.any(String), body: 'mine' }
      ])
    }
  )

  it("still saves this copy's own edit of a note after a failed save", async () => {
    const { host, add, edit } = setup(LOCAL, [note('x', 'v1')])
    host.refuseNext = true
    expect(await add('unrelated')).toBeNull()

    expect(await edit('x', 'v1 edited here')).toBe(true)

    expect(host.notes()).toEqual([{ id: 'x', body: 'v1 edited here' }])
  })
})
