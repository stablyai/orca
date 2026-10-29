import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { EditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import type { WorktreeOperationRoute } from '@/lib/worktree-operation-route'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { editorMoveOwnerFromContext, isOpenFileOnMoveOwner } from './open-editor-move-owner'

function captured(route: WorktreeOperationRoute): EditorFileOperationProvenance {
  return {
    ownershipProjection: 'explicit',
    generation: {
      route,
      runtimeConnectionGeneration: null,
      runtimePairingRevision: undefined,
      runtimeSshGeneration: null,
      nestedSshGeneration: null,
      directSshGeneration: null
    }
  }
}

// As openFile records it: the tab's server matches the one its route names.
const tab = (operationProvenance?: EditorFileOperationProvenance) => ({
  worktreeId: 'wt-1',
  runtimeEnvironmentId: operationProvenance?.generation.route.runtimeEnvironmentId ?? null,
  ...(operationProvenance ? { operationProvenance } : {})
})

describe('isOpenFileOnMoveOwner', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
  })

  it('never moves a direct-SSH tab for a rename on this app, and moves it for its own host', () => {
    const state = useAppStore.getState()
    const local = tab(captured({ executionHostId: 'local', runtimeEnvironmentId: null }))
    const ssh = tab(captured({ executionHostId: 'ssh:box', runtimeEnvironmentId: null }))
    const fromLocal = editorMoveOwnerFromContext(
      { target: { kind: 'local' }, expectedExecutionHostId: 'local' },
      'wt-1'
    )
    const fromSsh = editorMoveOwnerFromContext(
      { target: { kind: 'local' }, expectedExecutionHostId: 'ssh:box' },
      'wt-1'
    )
    expect([local, ssh].map((file) => isOpenFileOnMoveOwner(state, file, fromLocal))).toEqual([
      true,
      false
    ])
    expect(isOpenFileOnMoveOwner(state, ssh, fromSsh)).toBe(true)
  })

  it('moves a tab recorded as local when the File Explorer resolves its folder to an SSH host', () => {
    const state = useAppStore.getState()
    // An unstamped folder of SSH repos: the tab's route says this app, its rename goes to the host.
    const folderTab = tab(captured({ executionHostId: 'local', runtimeEnvironmentId: null }))
    const owner = editorMoveOwnerFromContext(
      { target: { kind: 'local' }, expectedExecutionHostId: 'ssh:box' },
      'wt-1'
    )
    expect(isOpenFileOnMoveOwner(state, folderTab, owner)).toBe(true)
  })

  it('moves a server tab whose route names only the server when the rename ran on its SSH host', () => {
    const state = useAppStore.getState()
    const serverTab = tab(
      captured({ executionHostId: 'runtime:env-a', runtimeEnvironmentId: 'env-a' })
    )
    const owner = editorMoveOwnerFromContext(
      {
        target: { kind: 'environment', environmentId: 'env-a' },
        expectedExecutionHostId: 'ssh:box'
      },
      'wt-1'
    )
    expect(isOpenFileOnMoveOwner(state, serverTab, owner)).toBe(true)
  })

  it('never moves another server’s tab for the same workspace id', () => {
    const state = useAppStore.getState()
    const owner = editorMoveOwnerFromContext(
      { target: { kind: 'environment', environmentId: 'env-a' }, expectedExecutionHostId: 'local' },
      'wt-1'
    )
    expect(
      isOpenFileOnMoveOwner(
        state,
        tab(captured({ executionHostId: 'runtime:env-b', runtimeEnvironmentId: 'env-b' })),
        owner
      )
    ).toBe(false)
    expect(isOpenFileOnMoveOwner(state, tab(), owner)).toBe(false)
  })

  it('moves a tab from another workspace only when that workspace is on the renaming host', () => {
    useAppStore.setState({
      repos: [
        { ...TEST_REPO, id: 'repo-ssh', connectionId: 'box' },
        { ...TEST_REPO, id: 'repo-local' }
      ],
      worktreesByRepo: {
        'repo-ssh': [makeWorktree({ id: 'wt-ssh', repoId: 'repo-ssh' })],
        'repo-local': [makeWorktree({ id: 'wt-local', repoId: 'repo-local' })]
      }
    })
    const state = useAppStore.getState()
    const owner = editorMoveOwnerFromContext(
      { target: { kind: 'local' }, expectedExecutionHostId: 'ssh:box' },
      'wt-1'
    )
    const inWorkspace = (worktreeId: string) => ({ worktreeId, runtimeEnvironmentId: null })
    expect(isOpenFileOnMoveOwner(state, inWorkspace('wt-ssh'), owner)).toBe(true)
    expect(isOpenFileOnMoveOwner(state, inWorkspace('wt-local'), owner)).toBe(false)
  })
})
