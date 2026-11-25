// @orca-isolated-worker: stubs `window` at load and shares its mock objects with every importer.
import { vi } from 'vitest'
import { createModelHost, type HostKind, type OrdinaryUpdates } from './folder-note-test-model-host'
import { create } from 'zustand'
import type { AppState } from '../../types'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import type { FolderDiffCommentMergeRequest } from '../../../../../shared/file-review/folder-diff-comment-merge'
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
import { makeProjectGroup } from '@/components/sidebar/workspace-creation/folder/folder-workspace-composer-submit-fixtures'

export { createModelHost, type HostKind, type ModelHost } from './folder-note-test-model-host'

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
      removedRuntimeEnvironmentIds: new Set<string>(),
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
      if (args.method === 'folderWorkspace.list') {
        const list = host.pairedLists.shift()
        await list?.gate
        return reply({ folderWorkspaces: [list?.sampled ?? structuredClone(host.row)] })
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
      if (kind === 'local') {
        folderWorkspacesApi.list.mockImplementationOnce(async () => {
          await gate
          return [sampled]
        })
      } else {
        host.pairedLists.push({ gate, sampled })
      }
      // The catalog of the host that owns the folder: local, or the paired server's list.
      const owning = owner()
      const done = store.getState().fetchFolderWorkspaces({
        runtimeEnvironmentId:
          owning.kind === 'folder' ? (owning.runtimeEnvironmentId ?? null) : null
      })
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
