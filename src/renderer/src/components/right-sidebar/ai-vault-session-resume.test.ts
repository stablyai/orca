import { describe, expect, it } from 'vitest'
import type { Repo, Worktree } from '../../../../shared/types'
import type { AiVaultSessionWorktreeInfo } from './ai-vault-session-worktree'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { resolveAiVaultSessionLaunchTarget } from './ai-vault-session-launch-actions'
import {
  aiVaultSessionResumeLabel,
  aiVaultSessionRowResumeGating,
  type AiVaultSessionResumeTargetState,
  resolveAiVaultSessionResumeActions,
  resolveAiVaultSessionResumeState
} from './ai-vault-session-resume'

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo/orca',
    repoId: 'repo-1',
    displayName: 'orca',
    path: '/repo/orca',
    head: 'abc123',
    branch: 'main',
    isBare: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    isMainWorktree: false,
    ...overrides
  }
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo/orca',
    displayName: 'orca',
    badgeColor: '#000000',
    addedAt: 1,
    ...overrides
  }
}

function makeTargetState(
  overrides: Partial<AiVaultSessionResumeTargetState> = {}
): AiVaultSessionResumeTargetState {
  return {
    folderWorkspaces: [],
    projectGroups: [],
    repos: [],
    worktreesByRepo: {},
    ...overrides
  } as AiVaultSessionResumeTargetState
}

function makeFolderTargetState(
  projectGroup: Partial<AiVaultSessionResumeTargetState['projectGroups'][number]>
): AiVaultSessionResumeTargetState {
  return makeTargetState({
    folderWorkspaces: [
      {
        id: 'folder-1',
        projectGroupId: 'group-1',
        name: 'Platform',
        folderPath: '/repo/platform',
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 1,
        createdAt: 1,
        updatedAt: 1
      }
    ],
    projectGroups: [
      {
        id: 'group-1',
        name: 'Platform',
        parentPath: null,
        parentGroupId: null,
        createdFrom: 'manual',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 1,
        updatedAt: 1,
        ...projectGroup
      }
    ]
  })
}

function makeWorktreeInfo(
  status: AiVaultSessionWorktreeInfo['status']
): AiVaultSessionWorktreeInfo {
  return {
    status,
    label: 'orca',
    path: '/repo/orca',
    ...(status === 'unavailable' ? {} : { worktreeId: 'repo-1::/repo/orca' })
  }
}

const HOST_SESSION_FILE = '/Users/ada/.claude/projects/-repo-orca/session-1.jsonl'
const WSL_SESSION_FILE =
  '\\\\wsl$\\Ubuntu\\home\\ada\\.claude\\projects\\-repo-orca\\session-1.jsonl'

describe('resolveAiVaultSessionResumeState', () => {
  it('prefers the session worktree over the active workspace', () => {
    expect(
      resolveAiVaultSessionResumeState({
        sessionFilePath: HOST_SESSION_FILE,
        worktreeInfo: makeWorktreeInfo('active'),
        activeWorktreeId: 'repo-1::/repo/other',
        worktrees: [
          makeWorktree(),
          makeWorktree({ id: 'repo-1::/repo/other', path: '/repo/other' })
        ],
        repos: [{ id: 'repo-1' } as Repo]
      })
    ).toEqual({
      blocked: false,
      worktreeId: 'repo-1::/repo/orca',
      usesSessionWorktree: true
    })
  })

  it('falls back to the active workspace when the session worktree is unavailable', () => {
    expect(
      resolveAiVaultSessionResumeState({
        sessionFilePath: HOST_SESSION_FILE,
        worktreeInfo: makeWorktreeInfo('archived'),
        activeWorktreeId: 'repo-1::/repo/orca',
        worktrees: [makeWorktree()],
        repos: [{ id: 'repo-1' } as Repo]
      })
    ).toEqual({
      blocked: false,
      worktreeId: 'repo-1::/repo/orca',
      usesSessionWorktree: false
    })
  })

  it('blocks missing worktrees even when the repo is SSH-owned', () => {
    expect(
      resolveAiVaultSessionResumeState({
        sessionFilePath: HOST_SESSION_FILE,
        worktreeInfo: makeWorktreeInfo('active'),
        activeWorktreeId: null,
        worktrees: [],
        repos: [{ id: 'repo-1', connectionId: 'ssh-1' } as Repo]
      })
    ).toEqual({
      blocked: true,
      worktreeId: null,
      usesSessionWorktree: false
    })
  })

  it('allows SSH-owned session worktrees', () => {
    expect(
      resolveAiVaultSessionResumeState({
        sessionFilePath: WSL_SESSION_FILE,
        worktreeInfo: makeWorktreeInfo('active'),
        activeWorktreeId: null,
        worktrees: [makeWorktree()],
        repos: [makeRepo({ connectionId: 'ssh-1' })]
      })
    ).toEqual({
      blocked: false,
      worktreeId: 'repo-1::/repo/orca',
      usesSessionWorktree: true
    })
  })

  it('allows SSH-stamped worktrees even when the repo owner is runtime', () => {
    expect(
      resolveAiVaultSessionResumeState({
        sessionFilePath: WSL_SESSION_FILE,
        worktreeInfo: makeWorktreeInfo('active'),
        activeWorktreeId: null,
        worktrees: [makeWorktree({ hostId: 'ssh:ssh-1' })],
        repos: [makeRepo({ connectionId: null, executionHostId: 'runtime:env-1' })]
      })
    ).toEqual({
      blocked: false,
      worktreeId: 'repo-1::/repo/orca',
      usesSessionWorktree: true
    })
  })

  it('allows runtime-owned targets for matching runtime sessions', () => {
    expect(
      resolveAiVaultSessionResumeState({
        sessionFilePath: HOST_SESSION_FILE,
        sessionExecutionHostId: 'runtime:env-1',
        worktreeInfo: makeWorktreeInfo('active'),
        activeWorktreeId: null,
        worktrees: [makeWorktree()],
        repos: [
          makeRepo({
            connectionId: null,
            executionHostId: 'runtime:env-1'
          })
        ]
      })
    ).toEqual({
      blocked: false,
      worktreeId: 'repo-1::/repo/orca',
      usesSessionWorktree: true
    })
  })

  it('blocks runtime-owned targets for sessions from another host', () => {
    expect(
      resolveAiVaultSessionResumeState({
        sessionFilePath: HOST_SESSION_FILE,
        sessionExecutionHostId: 'local',
        worktreeInfo: makeWorktreeInfo('active'),
        activeWorktreeId: null,
        worktrees: [makeWorktree()],
        repos: [
          makeRepo({
            connectionId: null,
            executionHostId: 'runtime:env-1'
          })
        ]
      })
    ).toEqual({
      blocked: true,
      worktreeId: null,
      usesSessionWorktree: false
    })
  })

  it('allows runtime-stamped worktrees even when the repo owner is local', () => {
    expect(
      resolveAiVaultSessionResumeState({
        sessionFilePath: HOST_SESSION_FILE,
        sessionExecutionHostId: 'runtime:env-1',
        worktreeInfo: makeWorktreeInfo('active'),
        activeWorktreeId: null,
        worktrees: [makeWorktree({ hostId: 'runtime:env-1' })],
        repos: [makeRepo({ connectionId: null, executionHostId: 'local' })]
      })
    ).toEqual({
      blocked: false,
      worktreeId: 'repo-1::/repo/orca',
      usesSessionWorktree: true
    })
  })

  it('prefers the session worktree when the active workspace is SSH-owned', () => {
    expect(
      resolveAiVaultSessionResumeState({
        sessionFilePath: HOST_SESSION_FILE,
        worktreeInfo: makeWorktreeInfo('active'),
        activeWorktreeId: 'repo-2::/remote/orca',
        worktrees: [
          makeWorktree(),
          makeWorktree({
            id: 'repo-2::/remote/orca',
            repoId: 'repo-2',
            path: '/remote/orca'
          })
        ],
        repos: [{ id: 'repo-1' } as Repo, { id: 'repo-2', connectionId: 'ssh-1' } as Repo]
      })
    ).toEqual({
      blocked: false,
      worktreeId: 'repo-1::/repo/orca',
      usesSessionWorktree: true
    })
  })

  it('falls back to the active workspace when the session worktree is runtime-owned', () => {
    expect(
      resolveAiVaultSessionResumeState({
        sessionFilePath: HOST_SESSION_FILE,
        worktreeInfo: makeWorktreeInfo('active'),
        activeWorktreeId: 'repo-2::/repo/other',
        worktrees: [
          makeWorktree(),
          makeWorktree({
            id: 'repo-2::/repo/other',
            repoId: 'repo-2',
            path: '/repo/other'
          })
        ],
        repos: [
          makeRepo({ connectionId: null, executionHostId: 'runtime:env-1' }),
          makeRepo({
            id: 'repo-2',
            path: '/repo/other',
            connectionId: null,
            executionHostId: 'local'
          })
        ]
      })
    ).toEqual({
      blocked: false,
      worktreeId: 'repo-2::/repo/other',
      usesSessionWorktree: false
    })
  })

  it('falls back to an active SSH folder workspace', () => {
    expect(
      resolveAiVaultSessionResumeState({
        sessionFilePath: WSL_SESSION_FILE,
        worktreeInfo: makeWorktreeInfo('archived'),
        activeWorktreeId: folderWorkspaceKey('folder-1'),
        worktrees: [],
        repos: [],
        targetState: makeFolderTargetState({ id: 'group-1', connectionId: 'ssh-1' })
      })
    ).toEqual({
      blocked: false,
      worktreeId: folderWorkspaceKey('folder-1'),
      usesSessionWorktree: false
    })
  })

  it('blocks host-stored sessions when only an SSH workspace is open', () => {
    expect(
      resolveAiVaultSessionResumeState({
        sessionFilePath: HOST_SESSION_FILE,
        worktreeInfo: makeWorktreeInfo('archived'),
        activeWorktreeId: folderWorkspaceKey('folder-1'),
        worktrees: [],
        repos: [],
        targetState: makeFolderTargetState({ id: 'group-1', connectionId: 'ssh-1' })
      })
    ).toEqual({
      blocked: true,
      worktreeId: null,
      usesSessionWorktree: false
    })
  })

  it('allows an active runtime folder workspace for matching runtime sessions', () => {
    expect(
      resolveAiVaultSessionResumeState({
        sessionFilePath: HOST_SESSION_FILE,
        sessionExecutionHostId: 'runtime:env-1',
        worktreeInfo: makeWorktreeInfo('archived'),
        activeWorktreeId: folderWorkspaceKey('folder-1'),
        worktrees: [],
        repos: [],
        targetState: makeFolderTargetState({ id: 'group-1', executionHostId: 'runtime:env-1' })
      })
    ).toEqual({
      blocked: false,
      worktreeId: folderWorkspaceKey('folder-1'),
      usesSessionWorktree: false
    })
  })
})

describe('resolveAiVaultSessionResumeActions', () => {
  it('exposes separate session-worktree and active-workspace targets', () => {
    expect(
      resolveAiVaultSessionResumeActions({
        sessionFilePath: HOST_SESSION_FILE,
        worktreeInfo: makeWorktreeInfo('active'),
        activeWorktreeId: 'repo-1::/repo/other',
        worktrees: [
          makeWorktree(),
          makeWorktree({ id: 'repo-1::/repo/other', path: '/repo/other' })
        ],
        repos: [{ id: 'repo-1' } as Repo]
      })
    ).toEqual({
      worktree: { worktreeId: 'repo-1::/repo/orca', disabled: false },
      newTab: { worktreeId: 'repo-1::/repo/other', disabled: false }
    })
  })

  it('enables an SSH active-workspace action when the session worktree is local', () => {
    expect(
      resolveAiVaultSessionResumeActions({
        sessionFilePath: WSL_SESSION_FILE,
        worktreeInfo: makeWorktreeInfo('active'),
        activeWorktreeId: 'repo-2::/remote/orca',
        worktrees: [
          makeWorktree(),
          makeWorktree({
            id: 'repo-2::/remote/orca',
            repoId: 'repo-2',
            path: '/remote/orca'
          })
        ],
        repos: [{ id: 'repo-1' } as Repo, { id: 'repo-2', connectionId: 'ssh-1' } as Repo]
      })
    ).toEqual({
      worktree: { worktreeId: 'repo-1::/repo/orca', disabled: false },
      newTab: { worktreeId: 'repo-2::/remote/orca', disabled: false }
    })
  })

  it('disables the SSH active-workspace action for host-stored sessions', () => {
    expect(
      resolveAiVaultSessionResumeActions({
        sessionFilePath: HOST_SESSION_FILE,
        worktreeInfo: makeWorktreeInfo('active'),
        activeWorktreeId: 'repo-2::/remote/orca',
        worktrees: [
          makeWorktree(),
          makeWorktree({
            id: 'repo-2::/remote/orca',
            repoId: 'repo-2',
            path: '/remote/orca'
          })
        ],
        repos: [{ id: 'repo-1' } as Repo, { id: 'repo-2', connectionId: 'ssh-1' } as Repo]
      })
    ).toEqual({
      worktree: { worktreeId: 'repo-1::/repo/orca', disabled: false },
      newTab: { worktreeId: 'repo-2::/remote/orca', disabled: true }
    })
  })

  it('disables runtime-owned targets without disabling local targets', () => {
    expect(
      resolveAiVaultSessionResumeActions({
        sessionFilePath: HOST_SESSION_FILE,
        worktreeInfo: makeWorktreeInfo('active'),
        activeWorktreeId: 'repo-2::/repo/other',
        worktrees: [
          makeWorktree(),
          makeWorktree({
            id: 'repo-2::/repo/other',
            repoId: 'repo-2',
            path: '/repo/other'
          })
        ],
        repos: [
          makeRepo({ connectionId: null, executionHostId: 'runtime:env-1' }),
          makeRepo({
            id: 'repo-2',
            path: '/repo/other',
            connectionId: null,
            executionHostId: 'local'
          })
        ]
      })
    ).toEqual({
      worktree: { worktreeId: 'repo-1::/repo/orca', disabled: true },
      newTab: { worktreeId: 'repo-2::/repo/other', disabled: false }
    })
  })

  it('does not expose the active workspace as a duplicate new-tab target', () => {
    expect(
      resolveAiVaultSessionResumeActions({
        sessionFilePath: HOST_SESSION_FILE,
        worktreeInfo: makeWorktreeInfo('current'),
        activeWorktreeId: 'repo-1::/repo/orca',
        worktrees: [makeWorktree()],
        repos: [{ id: 'repo-1' } as Repo]
      })
    ).toEqual({
      worktree: { worktreeId: 'repo-1::/repo/orca', disabled: false },
      newTab: { worktreeId: null, disabled: true }
    })
  })

  it('enables the active folder workspace action when it is local or SSH-owned', () => {
    expect(
      resolveAiVaultSessionResumeActions({
        sessionFilePath: WSL_SESSION_FILE,
        worktreeInfo: makeWorktreeInfo('archived'),
        activeWorktreeId: folderWorkspaceKey('folder-1'),
        worktrees: [],
        repos: [],
        targetState: makeFolderTargetState({ id: 'group-1', connectionId: 'ssh-1' })
      })
    ).toEqual({
      worktree: { worktreeId: null, disabled: true },
      newTab: { worktreeId: folderWorkspaceKey('folder-1'), disabled: false }
    })
  })

  it('enables the active folder workspace action when it is a matching runtime host', () => {
    expect(
      resolveAiVaultSessionResumeActions({
        sessionFilePath: HOST_SESSION_FILE,
        sessionExecutionHostId: 'runtime:env-1',
        worktreeInfo: makeWorktreeInfo('archived'),
        activeWorktreeId: folderWorkspaceKey('folder-1'),
        worktrees: [],
        repos: [],
        targetState: makeFolderTargetState({ id: 'group-1', executionHostId: 'runtime:env-1' })
      })
    ).toEqual({
      worktree: { worktreeId: null, disabled: true },
      newTab: { worktreeId: folderWorkspaceKey('folder-1'), disabled: false }
    })
  })
})

describe('resolveAiVaultSessionLaunchTarget', () => {
  it('allows direct resume into an active SSH folder workspace', () => {
    expect(
      resolveAiVaultSessionLaunchTarget({
        sessionFilePath: WSL_SESSION_FILE,
        activeWorktreeId: folderWorkspaceKey('folder-1'),
        targetState: makeFolderTargetState({ id: 'group-1', connectionId: 'ssh-1' })
      })
    ).toEqual({
      status: 'ready',
      worktreeId: folderWorkspaceKey('folder-1')
    })
  })

  it('blocks direct resume of a host-stored session into an SSH folder workspace', () => {
    expect(
      resolveAiVaultSessionLaunchTarget({
        sessionFilePath: HOST_SESSION_FILE,
        activeWorktreeId: folderWorkspaceKey('folder-1'),
        targetState: makeFolderTargetState({ id: 'group-1', connectionId: 'ssh-1' })
      })
    ).toEqual({
      status: 'unsupported',
      targetStatus: 'ssh'
    })
  })

  it('allows direct resume into a matching runtime folder workspace', () => {
    expect(
      resolveAiVaultSessionLaunchTarget({
        sessionFilePath: WSL_SESSION_FILE,
        sessionExecutionHostId: 'runtime:env-1',
        activeWorktreeId: folderWorkspaceKey('folder-1'),
        targetState: makeFolderTargetState({ id: 'group-1', executionHostId: 'runtime:env-1' })
      })
    ).toEqual({
      status: 'ready',
      worktreeId: folderWorkspaceKey('folder-1')
    })
  })

  it('blocks direct resume into a mismatched runtime folder workspace', () => {
    expect(
      resolveAiVaultSessionLaunchTarget({
        sessionFilePath: WSL_SESSION_FILE,
        sessionExecutionHostId: 'runtime:env-2',
        activeWorktreeId: folderWorkspaceKey('folder-1'),
        targetState: makeFolderTargetState({ id: 'group-1', executionHostId: 'runtime:env-1' })
      })
    ).toEqual({
      status: 'unsupported',
      targetStatus: 'runtime'
    })
  })
})

describe('aiVaultSessionResumeLabel', () => {
  it('names the session worktree action distinctly from the active-workspace fallback', () => {
    expect(aiVaultSessionResumeLabel({ usesSessionWorktree: true })).toBe('Resume in Worktree')
    expect(aiVaultSessionResumeLabel({ usesSessionWorktree: false })).toBe('Resume in New Tab')
  })
})

describe('aiVaultSessionRowResumeGating', () => {
  const zeroTurnSession = { messageCount: 0, previewMessages: [] }
  const sessionWithTurns = { messageCount: 3, previewMessages: [] }
  const unblocked = { blocked: false }

  it('withholds every resume affordance for a zero-turn session', () => {
    expect(aiVaultSessionRowResumeGating(zeroTurnSession, unblocked)).toEqual({
      resumeDisabled: true,
      canCopyResumeCommand: false
    })
  })

  it('keeps copy-resume available when only the workspace target is blocked', () => {
    expect(aiVaultSessionRowResumeGating(sessionWithTurns, { blocked: true })).toEqual({
      resumeDisabled: true,
      canCopyResumeCommand: true
    })
    expect(aiVaultSessionRowResumeGating(sessionWithTurns, null)).toEqual({
      resumeDisabled: true,
      canCopyResumeCommand: true
    })
  })

  it('treats user/assistant previews as resumable content when the turn count is unknown', () => {
    const previewOnlySession = {
      messageCount: 0,
      previewMessages: [{ role: 'user' as const, text: 'hello', timestamp: null }]
    }
    expect(aiVaultSessionRowResumeGating(previewOnlySession, unblocked)).toEqual({
      resumeDisabled: false,
      canCopyResumeCommand: true
    })
  })

  it('enables resume for an unblocked session with turns', () => {
    expect(aiVaultSessionRowResumeGating(sessionWithTurns, unblocked)).toEqual({
      resumeDisabled: false,
      canCopyResumeCommand: true
    })
  })
})
