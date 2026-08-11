import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { captureEditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import { resolveRichMarkdownFileOwner } from './rich-markdown-file-owner'

const WORKTREE_ID = 'same-repo::/srv/worktree'
const FILE_PATH = '/srv/worktree/note.md'

function sshConnectionState(targetId: string) {
  return {
    targetId,
    status: 'connected' as const,
    error: null,
    reconnectAttempt: 0,
    connectionGeneration: 0
  }
}

function ownerState(): AppState {
  const state = {
    settings: { activeRuntimeEnvironmentId: null },
    repos: [
      {
        id: 'same-repo',
        connectionId: 'ssh-a',
        executionHostId: 'ssh:ssh-a'
      }
    ],
    worktreesByRepo: {
      'same-repo': [
        {
          id: WORKTREE_ID,
          repoId: 'same-repo',
          path: '/srv/worktree',
          hostId: 'ssh:ssh-a'
        }
      ]
    },
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogHydrated: true,
    removedRuntimeEnvironmentIds: new Set(),
    sshConnectionStates: new Map([['ssh-a', sshConnectionState('ssh-a')]]),
    sshStateByEnvironment: new Map(),
    openFiles: []
  } as unknown as AppState
  const provenance = captureEditorFileOperationProvenance(state, WORKTREE_ID, undefined, false)
  state.openFiles = [
    {
      id: FILE_PATH,
      filePath: FILE_PATH,
      worktreeId: WORKTREE_ID,
      operationProvenance: provenance
    } as AppState['openFiles'][number]
  ]
  return state
}

describe('resolveRichMarkdownFileOwner', () => {
  it('derives citation and clipboard ownership from the live file provenance', () => {
    const resolved = resolveRichMarkdownFileOwner(ownerState(), FILE_PATH, FILE_PATH, WORKTREE_ID)

    expect(resolved).toMatchObject({
      sourceOwner: { kind: 'ssh', connectionId: 'ssh-a' },
      worktreeRoot: '/srv/worktree',
      operationContext: { connectionId: 'ssh-a', expectedExecutionHostId: 'ssh:ssh-a' }
    })
  })

  it('fails closed when another host publishes the same worktree id', () => {
    const state = ownerState()
    state.repos = [
      ...state.repos,
      { id: 'same-repo', connectionId: 'ssh-b', executionHostId: 'ssh:ssh-b' } as never
    ]
    state.worktreesByRepo = {
      'same-repo': [
        ...state.worktreesByRepo['same-repo'],
        {
          id: WORKTREE_ID,
          repoId: 'same-repo',
          path: '/srv/worktree',
          hostId: 'ssh:ssh-b'
        } as never
      ]
    }
    state.sshConnectionStates = new Map([
      ...state.sshConnectionStates,
      ['ssh-b', sshConnectionState('ssh-b')]
    ])

    expect(resolveRichMarkdownFileOwner(state, FILE_PATH, FILE_PATH, WORKTREE_ID)).toBeNull()
  })
})
