import {
  registerEditorOwnerInterpretationContracts,
  runtimeEnvironment
} from './editor-file-operation-owner-interpretation.spec'
// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  assertEditorFileOperationCurrent,
  captureEditorFileOperationProvenance,
  getEditorFileOperationContext
} from './editor-file-operation-owner'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { applyOpenFileToState } from '@/store/slices/editor/actions/open-file-apply'
import { buildEditorSessionData } from './workspace-session'
import { restorableEditorFile } from '@/store/slices/editor/tabs/editor-tab-layout-owner'
import { isSameOwnedDocument } from '@/store/slices/editor/file-ids/same-owned-editor-document'
import { editorMoveOwnerFromContext, isOpenFileOnMoveOwner } from './open-editor-move-owner'
import { getEditorModelOwnerKey } from '@/components/editor/editor-model-owner'
import { loadWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-load'
import { saveWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-save'
import {
  addWorkspace,
  emptySession
} from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import {
  makeFolderWorkspace,
  makeProjectGroup
} from '@/components/sidebar/folder-workspace-composer-submit-fixtures'
import { ORCA_EDITOR_FILE_SAVED_EVENT } from '@/components/editor/editor-autosave'
import { createEditorSaveQueue } from '@/components/editor/editor-save-queue'
import type * as RuntimeFileMutationClient from '@/runtime/runtime-file-mutation-client'
import type { OpenFile } from '@/store/slices/editor'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import type { FileWriteResult } from '../../../shared/file-write-disk-precondition'

const { writeRuntimeFile } = vi.hoisted(() => ({ writeRuntimeFile: vi.fn() }))
vi.mock('@/runtime/runtime-file-mutation-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeFileMutationClient>()),
  writeRuntimeFile
}))

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const worktreeId = 'repo::/remote/repo'

beforeEach(() => {
  writeRuntimeFile.mockReset()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    settings: { activeRuntimeEnvironmentId: 'hub-b' } as never,
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogHydrated: true,
    removedRuntimeEnvironmentIds: new Set()
  })
})

describe('editor file operation owner', () => {
  it.each([true, false])(
    'does not settle an issued write onto a reused view (ok=%s)',
    async (ok) => {
      const source: OpenFile = {
        id: 'reused-view',
        worktreeId: 'local-worktree',
        filePath: '/repo/source.md',
        relativePath: 'source.md',
        mode: 'edit',
        language: 'markdown',
        runtimeEnvironmentId: null,
        lastKnownDiskSignature: 'source baseline',
        isDirty: true
      }
      useAppStore.setState({
        repos: [{ ...TEST_REPO, path: '/repo', executionHostId: 'local' }],
        worktreesByRepo: {
          [TEST_REPO.id]: [
            makeWorktree({
              id: source.worktreeId,
              repoId: TEST_REPO.id,
              path: '/repo',
              hostId: 'local'
            })
          ]
        },
        openFiles: [source],
        editorDrafts: { [source.id]: 'source text' }
      })
      let finish!: (result: FileWriteResult) => void
      writeRuntimeFile.mockReset().mockReturnValueOnce(
        new Promise<FileWriteResult>((resolve) => {
          finish = resolve
        })
      )
      const events = vi.spyOn(window, 'dispatchEvent')
      const queue = createEditorSaveQueue(useAppStore)
      const pending = queue.queueSave(source, 'source text')
      await vi.waitFor(() => expect(writeRuntimeFile).toHaveBeenCalledOnce())
      const replacement: OpenFile = {
        ...source,
        filePath: '/repo/other.md',
        relativePath: 'other.md',
        lastKnownDiskSignature: 'other baseline'
      }
      useAppStore.getState().closeFile(source.id, { captureRecentlyClosed: false })
      useAppStore.setState({
        openFiles: [replacement],
        editorDrafts: { [source.id]: 'other draft' }
      })
      finish(ok ? { ok: true } : { ok: false, diskConflict: 'missing' })
      await expect(pending).resolves.toBe(ok ? 'written' : 'blocked-stale')
      expect(useAppStore.getState().openFiles[0]).toEqual(replacement)
      expect(useAppStore.getState().editorDrafts[source.id]).toBe('other draft')
      expect(
        events.mock.calls.filter(([event]) => event.type === ORCA_EDITOR_FILE_SAVED_EVENT)
      ).toEqual([])
      events.mockRestore()
      queue.dispose()
    }
  )
  it('retains published hints and owner-only capture without inventing physical-local evidence', () => {
    useAppStore.setState({
      worktreesByRepo: {
        repo: [
          makeWorktree({ id: worktreeId, repoId: 'repo', path: '/remote/repo', hostId: undefined })
        ]
      }
    })
    const hinted = captureEditorFileOperationProvenance(
      useAppStore.getState(),
      worktreeId,
      'hub-a',
      true
    )
    expect(hinted.generation.authority).toBeUndefined()
    expect(assertEditorFileOperationCurrent(useAppStore.getState(), worktreeId, hinted)).toEqual(
      hinted.generation.route
    )
    useAppStore.setState({
      worktreesByRepo: {
        repo: [
          {
            id: worktreeId,
            repoId: 'repo',
            path: '/remote/repo',
            runtimeOwnerEnvironmentId: 'hub-a'
          } as never
        ]
      }
    })
    const ownerOnly = captureEditorFileOperationProvenance(
      useAppStore.getState(),
      worktreeId,
      'hub-a',
      true
    )
    expect(ownerOnly.generation.authority).toBeUndefined()
    expect(assertEditorFileOperationCurrent(useAppStore.getState(), worktreeId, ownerOnly)).toEqual(
      ownerOnly.generation.route
    )
    expect(ownerOnly.generation.route).toEqual({
      runtimeEnvironmentId: 'hub-a',
      executionHostId: null
    })
  })
  it('keeps catalog identity and drafts across capture, saved writers and reload while fencing physical retargets', async () => {
    const id = 'folder:physical-owner'
    useAppStore.setState({
      activeWorktreeId: id,
      activeWorkspaceExecutionHostId: 'runtime:hub-a',
      folderWorkspaces: [
        makeFolderWorkspace({
          id: 'physical-owner',
          folderPath: '/local',
          executionHostId: 'local'
        }),
        makeFolderWorkspace({
          id: 'physical-owner',
          folderPath: '/remote',
          projectGroupId: 'physical-group'
        })
      ],
      projectGroups: [
        {
          ...makeProjectGroup(),
          id: 'physical-group',
          executionHostId: 'runtime:hub-a',
          connectionId: 'box'
        }
      ],
      sshStateByEnvironment: new Map([
        [
          'hub-a',
          {
            targetsHydrated: true,
            targetLabels: new Map([
              ['box', 'box'],
              ['other', 'other']
            ]),
            targetGenerations: new Map([
              ['box', 7],
              ['other', 7]
            ]),
            removedTargetLabels: new Map(),
            connectionStates: new Map(
              ['box', 'other'].map((targetId) => [
                targetId,
                {
                  targetId,
                  status: 'connected' as const,
                  error: null,
                  reconnectAttempt: 0,
                  connectionGeneration: 7
                }
              ])
            )
          }
        ]
      ])
    })
    const initial = useAppStore.getState()
    const scratch = {
      editorItemFileId: '',
      editorItemTargetGroupId: undefined,
      editorItemIsPreview: false,
      refused: false
    }
    useAppStore.setState(
      applyOpenFileToState(
        initial,
        {
          worktreeId: id,
          filePath: '/remote/a.md',
          relativePath: 'a.md',
          language: 'markdown',
          mode: 'edit',
          runtimeEnvironmentId: 'hub-a'
        },
        { preview: true },
        scratch
      )
    )
    const file = useAppStore.getState().openFiles[0]
    const provenance = file.operationProvenance!
    const incoming = { ...provenance, expectedSshConnectionGeneration: 8 }
    const reopened = {
      worktreeId: file.worktreeId,
      filePath: file.filePath,
      relativePath: file.relativePath,
      language: file.language,
      mode: file.mode,
      runtimeEnvironmentId: file.runtimeEnvironmentId,
      operationProvenance: incoming
    }
    useAppStore.setState(applyOpenFileToState(useAppStore.getState(), reopened, undefined, scratch))
    expect(useAppStore.getState().openFiles[0].operationProvenance).toBe(provenance)
    const externalRefresh = applyOpenFileToState(
      useAppStore.getState(),
      { ...reopened, externalSshTargetId: 'box' },
      undefined,
      scratch
    )
    expect(externalRefresh.openFiles?.[0].operationProvenance).toBe(incoming)
    expect(provenance.generation.route).toEqual({
      executionHostId: 'runtime:hub-a',
      runtimeEnvironmentId: 'hub-a'
    })
    expect(provenance.generation.authority).toEqual({
      endpoint: { kind: 'environment', environmentId: 'hub-a' },
      at: 'ssh:box'
    })
    const context = getEditorFileOperationContext(useAppStore.getState(), file, '')
    expect(context).toMatchObject({
      target: { kind: 'environment', environmentId: 'hub-a' },
      worktreePath: '/remote',
      expectedExecutionHostId: 'ssh:box',
      expectedSshConnectionGeneration: 7
    })
    const key = getEditorModelOwnerKey(file, initial)
    expect(key).toBe(JSON.stringify(['hub-a', 'ssh:box']))
    const saved = buildEditorSessionData(
      [{ ...file, isDirty: true }],
      { [file.id]: 'retained draft' },
      {},
      { [id]: file.id },
      { [id]: 'editor' }
    )
    const layoutRecord = restorableEditorFile(file)
    expect(JSON.stringify([saved, layoutRecord])).not.toContain('authority')
    expect(JSON.stringify([saved, layoutRecord])).not.toContain('operationProvenance')
    const loaded = loadWorkspaceLayout(
      'local',
      {
        ...addWorkspace(
          emptySession(),
          id,
          [
            {
              id: 'editor-group',
              tabs: [{ id: file.id, kind: 'editor', entry: { isPreview: true } }]
            }
          ],
          'runtime:hub-a'
        ),
        ...saved
      },
      { mintId: () => 'group', mintLeafId: () => '00000000-0000-4000-8000-000000000001' }
    )
    const roundTrip = JSON.parse(JSON.stringify(saveWorkspaceLayout(loaded)))
    expect(roundTrip.openFilesByWorktree[id][0]).toMatchObject({
      filePath: file.filePath,
      runtimeEnvironmentId: 'hub-a',
      dirtyDraftContent: 'retained draft',
      isPreview: true
    })
    useAppStore.getState().hydrateEditorSession(roundTrip)
    const restored = useAppStore.getState().openFiles[0]
    expect(restored.id).toBe(file.id)
    expect(useAppStore.getState().editorDrafts[restored.id]).toBe('retained draft')
    expect(getEditorFileOperationContext(useAppStore.getState(), restored, '')).toMatchObject(
      context
    )
    expect(restored.operationProvenance).toBeUndefined()
    expect(getEditorModelOwnerKey(restored, useAppStore.getState())).toBe(
      JSON.stringify(['hub-a', 'runtime:hub-a'])
    )
    let finishWrite!: (value: { ok: true }) => void
    writeRuntimeFile.mockResolvedValue({ ok: true }).mockReturnValueOnce(
      new Promise<{ ok: true }>((resolve) => {
        finishWrite = resolve
      })
    )
    const queue = createEditorSaveQueue(useAppStore)
    useAppStore.getState().setLastKnownDiskSignature(restored.id, 'baseline')
    useAppStore.getState().markFileDirty(restored.id, true)
    const firstSave = queue.queueSave(useAppStore.getState().openFiles[0], 'first')
    expect(
      getEditorModelOwnerKey(useAppStore.getState().openFiles[0], useAppStore.getState())
    ).toBe(key)
    await vi.waitFor(() => expect(writeRuntimeFile).toHaveBeenCalledOnce())
    expect(writeRuntimeFile.mock.calls[0][0]).toMatchObject(context)
    useAppStore.getState().setEditorDraft(restored.id, 'queued revised draft')
    const secondSave = queue.queueSave(useAppStore.getState().openFiles[0], 'second')
    const settlement = secondSave.then(
      (result) => ({ result, error: null }),
      (error: unknown) => ({ result: null, error })
    )
    useAppStore.setState({
      projectGroups: [
        {
          ...makeProjectGroup(),
          id: 'physical-group',
          executionHostId: 'runtime:hub-a',
          connectionId: 'other'
        }
      ]
    })
    finishWrite({ ok: true })
    await expect(firstSave).resolves.toBe('written')
    const secondOutcome = await settlement
    queue.dispose()
    expect(writeRuntimeFile.mock.calls.map(([args]) => args.expectedExecutionHostId)).toEqual([
      'ssh:box'
    ])
    expect(secondOutcome.error).toMatchObject({
      message: expect.stringContaining('Reopen the file')
    })
    expect(useAppStore.getState().editorDrafts[restored.id]).toBe('queued revised draft')
    expect(() => getEditorFileOperationContext(useAppStore.getState(), file, '')).toThrow(
      'Reopen the file'
    )
    const next = captureEditorFileOperationProvenance(useAppStore.getState(), id, 'hub-a', true)
    expect(isSameOwnedDocument({ ...file, operationProvenance: next }, file)).toBe(false)
    const replacement = { ...file, id: 'other-host', operationProvenance: next, isDirty: false }
    useAppStore.setState((state) => ({ openFiles: [...state.openFiles, replacement] }))
    expect(useAppStore.getState().editorBufferIdOf[replacement.id]).not.toBe(
      useAppStore.getState().editorBufferIdOf[file.id]
    )
    expect(useAppStore.getState().editorDrafts[replacement.id]).toBeUndefined()
    const other = getEditorFileOperationContext(
      useAppStore.getState(),
      { ...file, operationProvenance: next },
      ''
    )
    expect(
      isOpenFileOnMoveOwner(useAppStore.getState(), file, editorMoveOwnerFromContext(other, id))
    ).toBe(false)
    expect(
      isOpenFileOnMoveOwner(useAppStore.getState(), file, editorMoveOwnerFromContext(context, id))
    ).toBe(true)
    useAppStore.setState({
      projectGroups: [
        {
          ...makeProjectGroup(),
          id: 'physical-group',
          executionHostId: 'runtime:hub-a',
          connectionId: 'box'
        }
      ]
    })
    useAppStore.setState((state) => ({
      sshStateByEnvironment: new Map([
        [
          'hub-a',
          {
            ...state.sshStateByEnvironment.get('hub-a')!,
            connectionStates: new Map([
              [
                'box',
                {
                  targetId: 'box',
                  status: 'connected' as const,
                  error: null,
                  reconnectAttempt: 0,
                  connectionGeneration: 8
                }
              ]
            ])
          }
        ]
      ])
    }))
    const reconnected = {
      ...file,
      id: 'reconnected',
      operationProvenance: incoming,
      isDirty: false
    }
    useAppStore.setState((state) => ({ openFiles: [...state.openFiles, reconnected] }))
    expect(useAppStore.getState().editorBufferIdOf[reconnected.id]).toBe(
      useAppStore.getState().editorBufferIdOf[file.id]
    )
    expect(useAppStore.getState().editorDrafts[reconnected.id]).toBe('queued revised draft')
    expect(() => assertEditorFileOperationCurrent(useAppStore.getState(), id, provenance)).toThrow(
      'Reopen the file'
    )
  })
  it('round-trips the synthetic local owner for floating workspace files', () => {
    const provenance = captureEditorFileOperationProvenance(
      useAppStore.getState(),
      FLOATING_TERMINAL_WORKTREE_ID,
      null,
      true
    )

    expect(
      getEditorFileOperationContext(
        useAppStore.getState(),
        {
          worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
          runtimeEnvironmentId: null,
          operationProvenance: provenance
        },
        '/tmp/orca/floating-workspace'
      )
    ).toMatchObject({
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      worktreePath: '/tmp/orca/floating-workspace',
      expectedExecutionHostId: 'local'
    })
  })

  it('uses the explicit worktree owner instead of global runtime focus', () => {
    useAppStore.setState({
      worktreesByRepo: {
        repo: [
          {
            id: worktreeId,
            repoId: 'repo',
            path: '/remote/repo',
            hostId: 'runtime:hub-a',
            runtimeOwnerEnvironmentId: 'hub-a'
          } as never
        ]
      }
    })

    const provenance = captureEditorFileOperationProvenance(
      useAppStore.getState(),
      worktreeId,
      undefined,
      false
    )
    const context = getEditorFileOperationContext(
      useAppStore.getState(),
      { worktreeId, operationProvenance: provenance },
      '/remote/repo'
    )

    expect(context.target).toEqual({ kind: 'environment', environmentId: 'hub-a' })
  })

  it('rejects an open tab after the same environment id is re-paired', () => {
    useAppStore.getState().setRuntimeEnvironments([runtimeEnvironment('hub-a', 1)])
    useAppStore.setState({
      worktreesByRepo: {
        repo: [
          {
            id: worktreeId,
            repoId: 'repo',
            path: '/remote/repo',
            hostId: 'runtime:hub-a',
            runtimeOwnerEnvironmentId: 'hub-a'
          } as never
        ]
      }
    })
    const provenance = captureEditorFileOperationProvenance(
      useAppStore.getState(),
      worktreeId,
      undefined,
      false
    )

    useAppStore.getState().setRuntimeEnvironments([runtimeEnvironment('hub-a', 2)])

    expect(() =>
      assertEditorFileOperationCurrent(useAppStore.getState(), worktreeId, provenance)
    ).toThrow('Reopen the file')
  })

  it('captures and rejects replacement nested SSH connection generations', () => {
    useAppStore.setState({
      worktreesByRepo: {
        repo: [
          {
            id: worktreeId,
            repoId: 'repo',
            path: '/remote/repo',
            hostId: 'ssh:private',
            runtimeOwnerEnvironmentId: 'hub-a'
          } as never
        ]
      },
      sshStateByEnvironment: new Map([
        [
          'hub-a',
          {
            targetsHydrated: true,
            targetGenerations: new Map(),
            targetLabels: new Map([['private', 'private']]),
            removedTargetLabels: new Map(),
            connectionStates: new Map([
              [
                'private',
                {
                  targetId: 'private',
                  status: 'connected',
                  error: null,
                  reconnectAttempt: 0,
                  connectionGeneration: 7
                }
              ]
            ])
          }
        ]
      ])
    })
    const provenance = captureEditorFileOperationProvenance(
      useAppStore.getState(),
      worktreeId,
      undefined,
      false
    )
    expect(provenance.expectedSshConnectionGeneration).toBe(7)

    useAppStore.setState((state) => ({
      sshStateByEnvironment: new Map([
        [
          'hub-a',
          {
            ...state.sshStateByEnvironment.get('hub-a')!,
            connectionStates: new Map([
              [
                'private',
                {
                  targetId: 'private',
                  status: 'connected',
                  error: null,
                  reconnectAttempt: 0,
                  connectionGeneration: 8
                }
              ]
            ])
          }
        ]
      ])
    }))

    expect(() =>
      assertEditorFileOperationCurrent(useAppStore.getState(), worktreeId, provenance)
    ).toThrow('Reopen the file')
  })

  it('rejects a restored external SSH file after its target changes', () => {
    useAppStore.setState({
      repos: [{ id: 'repo', connectionId: 'ssh-replacement' } as never],
      worktreesByRepo: {
        repo: [{ id: worktreeId, repoId: 'repo', path: '/remote/repo' } as never]
      },
      sshConnectionStates: new Map([
        [
          'ssh-replacement',
          {
            targetId: 'ssh-replacement',
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            connectionGeneration: 1
          }
        ]
      ])
    })

    expect(() =>
      getEditorFileOperationContext(
        useAppStore.getState(),
        { worktreeId, externalSshTargetId: 'ssh-original' },
        '/remote/repo'
      )
    ).toThrow('Reopen the file')
  })

  describe('folder workspaces', () => {
    const folderWorkspaceId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const folderKey = `folder:${folderWorkspaceId}`

    beforeEach(() => {
      useAppStore.setState({
        folderWorkspaces: [
          {
            id: folderWorkspaceId,
            projectGroupId: 'group-1',
            connectionId: null,
            folderPath: '/workspace/folder'
          } as never
        ],
        projectGroups: [{ id: 'group-1', connectionId: null, executionHostId: null } as never],
        restoredRuntimeHostIdByWorkspaceSessionKey: {}
      })
    })

    it('round-trips capture and assert for a local folder workspace (#10251)', () => {
      const provenance = captureEditorFileOperationProvenance(
        useAppStore.getState(),
        folderKey,
        undefined,
        false
      )
      expect(provenance.generation.route).toEqual({
        executionHostId: 'local',
        runtimeEnvironmentId: null
      })
      expect(
        assertEditorFileOperationCurrent(useAppStore.getState(), folderKey, provenance)
      ).toEqual(provenance.generation.route)
    })

    it('uses the folder root when a legacy caller passes an empty worktree path', () => {
      useAppStore.setState({
        folderWorkspaces: [
          {
            id: folderWorkspaceId,
            projectGroupId: 'group-1',
            connectionId: null,
            folderPath: '/workspace/folder'
          } as never
        ]
      })
      const context = getEditorFileOperationContext(
        useAppStore.getState(),
        { worktreeId: folderKey },
        ''
      )

      expect(context.worktreePath).toBe('/workspace/folder')
    })

    it('fails closed when folder ownership changes between capture and assert', () => {
      const provenance = captureEditorFileOperationProvenance(
        useAppStore.getState(),
        folderKey,
        undefined,
        false
      )
      useAppStore.setState({
        projectGroups: [
          { id: 'group-1', connectionId: null, executionHostId: 'runtime:hub-a' } as never
        ]
      })
      expect(() =>
        assertEditorFileOperationCurrent(useAppStore.getState(), folderKey, provenance)
      ).toThrow('Reopen the file')
    })
  })
})

afterEach(() => vi.unstubAllGlobals())

registerEditorOwnerInterpretationContracts()
