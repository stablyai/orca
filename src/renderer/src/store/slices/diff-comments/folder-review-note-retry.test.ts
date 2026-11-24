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

/** One host's catalog row: it merges each write the way the real host does. */
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
          // An older server takes the list as sent, base or not.
          diffComments: merges
            ? applyDiffCommentWrite(host.row.diffComments, updates)
            : updates.diffComments
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
    bodies(): string[] {
      return (host.row.diffComments ?? []).map((entry) => entry.body)
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

  it.each([
    ['this computer', LOCAL],
    ['a paired server', PAIRED],
    ['an older paired server that replaces the list', OLDER_PAIRED]
  ])(
    'keeps a note another device added after a save that landed unacknowledged (%s)',
    async (_name, hostCase) => {
      const { host, add, shown } = setup(hostCase)
      host.dropNextAck = true
      // The save is reported as failed even though the host kept it.
      expect(await add('my note')).toBeNull()
      expect(host.bodies()).toEqual(['my note'])

      host.peerEdit((notes) => [...notes, note('peer', 'from another device', 2)])
      expect(await add('my note again')).not.toBeNull()

      // This copy's own notes converge to what it shows (the failed one was rolled back);
      // the note it never listed is another device's and stays.
      expect(host.bodies()).toEqual(['from another device', 'my note again'])
      expect(shown()).toEqual(['my note again'])
    }
  )

  it("keeps another device's edit to a note this copy still shows unchanged", async () => {
    const { host, add } = setup(LOCAL, [note('x', 'v1')])
    host.refuseNext = true
    expect(await add('unrelated')).toBeNull()

    host.peerEdit((notes) => notes.map((entry) => ({ ...entry, body: 'v2 from another device' })))
    expect(await add('mine', 3)).not.toBeNull()

    expect(host.bodies()).toEqual(['v2 from another device', 'mine'])
  })

  it('does not bring back a note another device deleted while this copy still shows it', async () => {
    const { host, add } = setup(LOCAL, [note('x', 'v1')])
    host.refuseNext = true
    expect(await add('unrelated')).toBeNull()

    host.peerEdit(() => [])
    expect(await add('mine', 3)).not.toBeNull()

    expect(host.bodies()).toEqual(['mine'])
  })

  it("keeps another device's edit to a note whose save landed unacknowledged", async () => {
    const { host, add } = setup(LOCAL)
    host.dropNextAck = true
    expect(await add('landed')).toBeNull()

    host.peerEdit((notes) => notes.map((entry) => ({ ...entry, body: 'edited elsewhere' })))
    expect(await add('mine', 3)).not.toBeNull()

    expect(host.bodies()).toEqual(['edited elsewhere', 'mine'])
  })

  it("still saves this copy's own edit of a note after a failed save", async () => {
    const { host, add, edit } = setup(LOCAL, [note('x', 'v1')])
    host.refuseNext = true
    expect(await add('unrelated')).toBeNull()

    expect(await edit('x', 'v1 edited here')).toBe(true)

    expect(host.bodies()).toEqual(['v1 edited here'])
  })
})
