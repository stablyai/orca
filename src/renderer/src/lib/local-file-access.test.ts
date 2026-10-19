import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { useAppStore } from '@/store'
import { editorTabDocumentFolderAccess, editorTabFileAccess } from './local-file-access'

const initialState = useAppStore.getInitialState()

function makeRepo(overrides: Partial<Repo> & { id: string; path: string }): Repo {
  return { displayName: 'repo', badgeColor: '#000', addedAt: 0, ...overrides }
}

function makeWorktree(overrides: Partial<Worktree> & { id: string; repoId: string }): Worktree {
  return {
    path: '/Users/me/project',
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    displayName: 'project',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

const localWorktreeId = 'repo-local::/Users/me/project'

type TabFileAccessFields = Parameters<typeof editorTabFileAccess>[1]

function accessKind(file: TabFileAccessFields): string | undefined {
  return editorTabFileAccess(useAppStore.getState(), file)?.kind
}

describe('editorTabFileAccess', () => {
  beforeEach(() => {
    useAppStore.setState({
      repos: [
        makeRepo({ id: 'repo-local', path: '/Users/me/project' }),
        makeRepo({ id: 'repo-ssh', path: '/work/project', connectionId: 'ssh-1' })
      ],
      worktreesByRepo: {
        'repo-local': [makeWorktree({ id: localWorktreeId, repoId: 'repo-local' })]
      }
    })
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
  })

  it.each<[string, TabFileAccessFields, string | undefined]>([
    [
      'a floating-workspace tab stored relative to ~',
      {
        filePath: '/Users/me/notes.txt',
        relativePath: 'notes.txt',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID
      },
      'user-file'
    ],
    [
      'a local tab stored by absolute path',
      { filePath: '/tmp/audit.md', relativePath: '/tmp/audit.md', worktreeId: localWorktreeId },
      'user-file'
    ],
    [
      'a project link opened by its absolute path because it leads out of the project',
      {
        filePath: '/Users/me/project/docs/link.md',
        relativePath: '/Users/me/project/docs/link.md',
        worktreeId: localWorktreeId
      },
      'user-file'
    ],
    [
      'an AI Vault log tab in an SSH workspace',
      {
        filePath: '/Users/me/.codex/session.jsonl',
        relativePath: '/Users/me/.codex/session.jsonl',
        worktreeId: 'repo-ssh::/work/project',
        readOnly: true,
        liveTail: true
      },
      'user-file'
    ],
    [
      'a read-only link to this computer opened in a server workspace backed by SSH',
      {
        filePath: '/Users/me/Desktop/review.md',
        relativePath: '/Users/me/Desktop/review.md',
        worktreeId: 'repo-ssh::/work/project',
        runtimeEnvironmentId: null,
        readOnly: true
      },
      'user-file'
    ],
    [
      'a read-only server file outside every workspace, restored without its grant',
      {
        filePath: '/tmp/out.png',
        relativePath: '/tmp/out.png',
        worktreeId: localWorktreeId,
        runtimeEnvironmentId: 'env-1',
        readOnly: true
      },
      undefined
    ],
    [
      'a project tab, which stays inside its root',
      { filePath: '/Users/me/project/a.ts', relativePath: 'a.ts', worktreeId: localWorktreeId },
      undefined
    ],
    [
      'an absolute tab owned by an SSH workspace',
      { filePath: '/work/x.md', relativePath: '/work/x.md', worktreeId: 'repo-ssh::/work/project' },
      undefined
    ],
    [
      'an absolute tab pinned to an SSH host',
      {
        filePath: '/work/x.md',
        relativePath: '/work/x.md',
        worktreeId: localWorktreeId,
        externalSshTargetId: 'ssh-1'
      },
      undefined
    ],
    [
      'a floating tab owned by a remote runtime',
      {
        filePath: '/Users/me/notes.txt',
        relativePath: 'notes.txt',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        runtimeEnvironmentId: 'runtime-1'
      },
      undefined
    ],
    [
      'an absolute tab whose owner has not loaded',
      {
        filePath: '/work/x.md',
        relativePath: '/work/x.md',
        worktreeId: 'repo-missing::/work/other'
      },
      undefined
    ],
    [
      'an absolute tab in a folder workspace with an unknown host',
      {
        filePath: '/home/remote/notes.md',
        relativePath: '/home/remote/notes.md',
        worktreeId: folderWorkspaceKey('fw-missing')
      },
      undefined
    ]
  ])('%s', (_label, file, expected) => {
    expect(accessKind(file)).toBe(expected)
  })
})

describe('editorTabDocumentFolderAccess', () => {
  beforeEach(() => {
    useAppStore.setState({
      repos: [
        makeRepo({ id: 'repo-local', path: '/Users/me/project' }),
        makeRepo({ id: 'repo-ssh', path: '/work/project', connectionId: 'ssh-1' })
      ],
      worktreesByRepo: {
        'repo-local': [makeWorktree({ id: localWorktreeId, repoId: 'repo-local' })]
      }
    })
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
  })

  it('declares the file itself for writes on a local user-named tab', () => {
    expect(
      editorTabDocumentFolderAccess(useAppStore.getState(), {
        filePath: '/Users/me/notes.md',
        relativePath: 'notes.md',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID
      })
    ).toEqual({ kind: 'document-folder', documentPath: '/Users/me/notes.md' })
  })

  it.each<[string, TabFileAccessFields]>([
    [
      'a project tab',
      { filePath: '/Users/me/project/a.md', relativePath: 'a.md', worktreeId: localWorktreeId }
    ],
    [
      'an absolute tab owned by an SSH workspace',
      { filePath: '/work/x.md', relativePath: '/work/x.md', worktreeId: 'repo-ssh::/work/project' }
    ],
    [
      'an AI Vault log tab',
      {
        filePath: '/Users/me/.codex/session.jsonl',
        relativePath: '/Users/me/.codex/session.jsonl',
        worktreeId: 'repo-ssh::/work/project',
        readOnly: true,
        liveTail: true
      }
    ]
  ])('grants no folder writes to %s', (_label, file) => {
    expect(editorTabDocumentFolderAccess(useAppStore.getState(), file)).toBeUndefined()
  })
})
