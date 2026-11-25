// @orca-isolated-worker: stubs `window` at load and shares its mock objects with every importer.
import { vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../../types'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import {
  applyDiffCommentWrite,
  type DiffCommentBaseMutation
} from '../../../../../shared/file-review/diff-comment-mutation'
import type {
  FolderDiffCommentMergeRequest,
  FolderDiffCommentReceipt
} from '../../../../../shared/file-review/folder-diff-comment-merge'
import { mergeFolderDiffCommentsOnHost } from '../../../../../shared/file-review/folder-diff-comment-merge-operation'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { createDiffCommentsSlice } from './create-diff-comments-slice'
import { resetDiffCommentPersistenceForTests } from './diff-comment-persistence'
import { resetFolderNoteProtectionForTests } from './folder-note-protection'
import { resetFolderNotesFenceForTests } from './folder-note-fence'
import { createFolderWorkspaceCatalogActions } from '../../folder-workspaces/folder-workspace-catalog-actions'
import { selectDiffCommentView, type DiffCommentOwner } from './diff-comment-owner'
import {
  makeFolderWorkspace,
  makeProjectGroup
} from '@/components/sidebar/workspace-creation/folder/folder-workspace-composer-submit-fixtures'

export const WORKSPACE_KEY = folderWorkspaceKey('folder-1')

/** Every module-level queue, protection and fence; test files may share these modules. */
export function resetFolderNoteTestState(): void {
  resetDiffCommentPersistenceForTests()
  resetFolderNoteProtectionForTests()
  resetFolderNotesFenceForTests()
}

export function note(id: string, body: string, lineNumber = 1): DiffComment {
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

export type HostKind = 'local' | 'paired' | 'paired-older'

type OrdinaryUpdates = { diffComments?: DiffComment[] } & DiffCommentBaseMutation

/** One host's folder row and how it answers each kind of note write. */
export function createModelHost(kind: HostKind, saved: DiffComment[]) {
  const host = {
    row: makeFolderWorkspace({
      id: 'folder-1',
      folderPath: '/workspace',
      ...(kind === 'local' ? { executionHostId: 'local' as const } : {}),
      diffComments: saved,
      createdAt: 7
    }),
    // An older paired server has no merge method and replaces the list on every update.
    supportsMerge: kind !== 'paired-older',
    clock: 1000,
    effects: { ordinary: 0, merges: 0, reads: 0 },
    /** Next ordinary update: 'refuse' never reaches the host; 'drop-ack' lands, reply lost. */
    nextOrdinary: 'ok' as 'ok' | 'refuse' | 'drop-ack',
    /** An ordinary update waits here before it reaches the host. */
    ordinaryGate: undefined as Promise<void> | undefined,
    /** Next merge-method calls, consumed in order. */
    nextMerges: [] as ('ok' | 'drop-ack' | 'refuse')[],
    mergeGate: undefined as Promise<void> | undefined,
    /** A read samples the row first, then waits here before its reply is delivered. */
    readGate: undefined as Promise<void> | undefined,
    /** Next reads, consumed in order: 'fail' never reaches the host. */
    nextReads: [] as ('ok' | 'fail')[],
    requests: [] as FolderDiffCommentMergeRequest[],
    ordinary(updates: OrdinaryUpdates): FolderWorkspace {
      const mode = host.nextOrdinary
      host.nextOrdinary = 'ok'
      if (mode === 'refuse') {
        throw new Error('host unreachable')
      }
      host.effects.ordinary += 1
      host.row = {
        ...host.row,
        updatedAt: host.clock--,
        diffComments:
          kind === 'paired-older'
            ? updates.diffComments
            : applyDiffCommentWrite(host.row.diffComments, updates)
      }
      if (mode === 'drop-ack') {
        throw new Error('connection lost')
      }
      return host.row
    },
    async merge(request: FolderDiffCommentMergeRequest): Promise<FolderDiffCommentReceipt> {
      host.requests.push(request)
      if (request.mode === 'read' && host.nextReads.shift() === 'fail') {
        throw new Error('host unreachable')
      }
      if (request.mode === 'merge') {
        await host.mergeGate
      }
      const mode = request.mode === 'read' ? 'ok' : (host.nextMerges.shift() ?? 'ok')
      const receipt = mergeFolderDiffCommentsOnHost(
        {
          rows: () => [host.row],
          visibleRows: () => [host.row],
          assertWritable: () => {
            if (mode === 'refuse') {
              throw new Error('fenced')
            }
          },
          update: (_id, updates) => {
            host.effects.merges += 1
            host.row = {
              ...host.row,
              updatedAt: host.clock--,
              diffComments: applyDiffCommentWrite(host.row.diffComments, updates)
            }
            return host.row
          },
          notify: () => {}
        },
        request
      )
      if (request.mode === 'read') {
        host.effects.reads += 1
        await host.readGate
      }
      if (mode === 'drop-ack') {
        throw new Error('connection lost')
      }
      return receipt
    },
    /** Another device's save, merged on the host. */
    peer(edit: (notes: DiffComment[]) => DiffComment[]): void {
      const current = host.row.diffComments ?? []
      host.row = {
        ...host.row,
        updatedAt: host.clock--,
        diffComments: applyDiffCommentWrite(current, {
          diffComments: edit(current),
          diffCommentsBase: current
        })
      }
    },
    notes(): string[] {
      return (host.row.diffComments ?? []).map((entry) => `${entry.id}=${entry.body}`)
    }
  }
  return host
}

export type ModelHost = ReturnType<typeof createModelHost>

export const folderWorkspacesApi = {
  update: vi.fn(),
  mergeDiffComments: vi.fn(),
  list: vi.fn()
}
export const runtimeEnvironmentCall = vi.fn()

vi.stubGlobal('window', {
  api: {
    folderWorkspaces: folderWorkspacesApi,
    runtimeEnvironments: {
      call: (args: RuntimeEnvironmentCallRequest) =>
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
    }
  }
})

function reply(result: unknown) {
  return { id: 'rpc', ok: true, result, _meta: { runtimeId: 'remote-runtime' } }
}

function refusal(code: string) {
  return {
    id: 'rpc',
    ok: false,
    error: { code, message: code },
    _meta: { runtimeId: 'remote-runtime' }
  }
}

function createTestStore() {
  return create<AppState>()((...args) => {
    const slice = createDiffCommentsSlice(...args)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial store with only the fields review-note owners and writes read.
    return {
      ...slice,
      ...createFolderWorkspaceCatalogActions(args[0], args[1]),
      folderWorkspaceCatalogByHost: {},
      folderWorkspacePathStatuses: {},
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

/** This copy, its host, and the actions a user takes. */
export function setupFolderNotes(kind: HostKind, saved: DiffComment[] = []) {
  const host = createModelHost(kind, saved)
  const hostId = kind === 'local' ? 'local' : 'runtime:env-owner'
  if (kind === 'local') {
    folderWorkspacesApi.list.mockImplementation(async () => [{ ...host.row }])
    folderWorkspacesApi.update.mockImplementation(async ({ updates }) => {
      await host.ordinaryGate
      return host.ordinary(updates)
    })
    folderWorkspacesApi.mergeDiffComments.mockImplementation((request) => host.merge(request))
  } else {
    runtimeEnvironmentCall.mockImplementation(async (args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'folderWorkspace.update') {
        const updates = (args.params as { updates?: OrdinaryUpdates } | undefined)?.updates ?? {}
        return reply({ folderWorkspace: host.ordinary(updates) })
      }
      if (args.method === 'folderWorkspace.mergeDiffComments') {
        if (!host.supportsMerge) {
          return refusal('method_not_found')
        }
        return reply(await host.merge(args.params as FolderDiffCommentMergeRequest))
      }
      throw new Error(`unexpected ${args.method}`)
    })
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
        ...(kind === 'local' ? {} : { connectionId: 'box' })
      }
    ],
    folderWorkspaces: [host.row]
  })
  const owner = (): DiffCommentOwner => {
    const found = selectDiffCommentView(store.getState(), WORKSPACE_KEY, 'selection').owner
    if (!found) {
      throw new Error('test folder is not resolvable')
    }
    return found
  }
  const shown = () =>
    store
      .getState()
      .getDiffComments(WORKSPACE_KEY)
      .map((entry) => `${entry.id}=${entry.body}`)
  return {
    host,
    store,
    owner,
    shown,
    add: (body: string, lineNumber = 1) =>
      store.getState().addDiffComment(owner(), {
        worktreeId: WORKSPACE_KEY,
        filePath: 'README.md',
        source: 'markdown',
        lineNumber,
        body,
        side: 'modified'
      }),
    edit: (id: string, body: string) => store.getState().updateDiffComment(owner(), id, body),
    remove: (id: string) => store.getState().deleteDiffComment(owner(), id),
    clear: () => store.getState().clearDiffComments(owner()),
    markSent: (ids: string[]) => store.getState().markDiffCommentsSent(owner(), ids, 5),
    /** A catalog refresh replacing this copy's row with what the host holds now. */
    refresh: () =>
      store.setState((state) => ({
        folderWorkspaces: state.folderWorkspaces.map((row) =>
          row.id === 'folder-1'
            ? { ...host.row, diffComments: [...(host.row.diffComments ?? [])] }
            : row
        )
      })),
    /**
     * A local folder catalog fetch through the store's own action. The host is sampled now; the
     * result lands when `deliver` runs, so a fetch can be delivered after later writes. `sample`
     * stands in for the host's row, e.g. one equal to what this copy already shows.
     */
    startCatalogFetch(sample: FolderWorkspace = host.row) {
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const sampled = structuredClone(sample)
      folderWorkspacesApi.list.mockImplementationOnce(async () => {
        await gate
        return [sampled]
      })
      const done = store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: null })
      return {
        deliver: async () => {
          release()
          await done
        }
      }
    },
    /** Makes the next ordinary save fail before reaching the host, so protection starts. */
    async failOnce(): Promise<void> {
      host.nextOrdinary = 'refuse'
      await store.getState().addDiffComment(owner(), {
        worktreeId: WORKSPACE_KEY,
        filePath: 'README.md',
        source: 'markdown',
        lineNumber: 9,
        body: 'refused',
        side: 'modified'
      })
    }
  }
}
