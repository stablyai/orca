import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Project } from '../../../../shared/project-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import { getAiVaultResumeWorkspaceWslDistro } from '@/lib/ai-vault-resume-shell'
import {
  type AiVaultSessionResumeTargetState,
  resolveAiVaultSessionResumeState
} from './ai-vault-session-resume'
import { resolveAiVaultSessionLaunchTarget } from './ai-vault-session-launch-target'

vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'win32' }))

const WSL_ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\ada'
const WSL_SESSION_FILE = `${WSL_ROOT}\\.pi\\agent\\sessions\\--home-ada-gone--\\s-1.jsonl`
const WINDOWS_SESSION_FILE = 'C:\\Users\\ada\\.claude\\projects\\C--repo\\s-1.jsonl'

const windowsWorktree = makeWorktree('win', 'C:\\repo')
const wslWorktree = makeWorktree('wsl', `${WSL_ROOT}\\repo`)
const otherDistroWorktree = makeWorktree('debian', '\\\\wsl.localhost\\Debian\\home\\ada\\repo')
const worktrees = [windowsWorktree, wslWorktree, otherDistroWorktree]
const repos: Repo[] = worktrees.map((worktree) => ({
  id: worktree.repoId,
  path: worktree.path,
  displayName: worktree.repoId,
  badgeColor: '#000000',
  addedAt: 1
}))

function makeWorktree(repoId: string, path: string): Worktree {
  return {
    id: `${repoId}::${path}`,
    repoId,
    displayName: repoId,
    path,
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
    isMainWorktree: false
  }
}

function targetState(
  projects: Project[] = [],
  settings = createGlobalSettingsFixture({ localWindowsRuntimeDefault: { kind: 'windows-host' } })
): AiVaultSessionResumeTargetState {
  return {
    folderWorkspaces: [],
    projectGroups: [],
    repos,
    worktreesByRepo: Object.fromEntries(worktrees.map((worktree) => [worktree.repoId, [worktree]])),
    projects,
    settings
  }
}

function resumeFromActive(sessionFilePath: string, activeWorktreeId: string) {
  // The session's own worktree is gone, so only the active workspace can host the resume.
  return resolveAiVaultSessionResumeState({
    sessionFilePath,
    worktreeInfo: { status: 'unavailable', label: 'gone', path: '/home/ada/gone' },
    activeWorktreeId,
    worktrees,
    repos,
    targetState: targetState()
  })
}

describe('resume across WSL and the Windows host', () => {
  it('blocks a WSL session from falling back to an active Windows-host workspace', () => {
    expect(resumeFromActive(WSL_SESSION_FILE, windowsWorktree.id).blocked).toBe(true)
  })

  it('resumes a WSL session in an active workspace on the same distro', () => {
    expect(resumeFromActive(WSL_SESSION_FILE, wslWorktree.id)).toEqual({
      blocked: false,
      worktreeId: wslWorktree.id,
      usesSessionWorktree: false
    })
  })

  it('blocks a WSL session in a workspace on another distro', () => {
    expect(resumeFromActive(WSL_SESSION_FILE, otherDistroWorktree.id).blocked).toBe(true)
  })

  it('blocks a Windows-host session from resuming inside a WSL workspace', () => {
    expect(resumeFromActive(WINDOWS_SESSION_FILE, wslWorktree.id).blocked).toBe(true)
  })

  it('keeps resuming Windows-host sessions on the Windows host', () => {
    expect(resumeFromActive(WINDOWS_SESSION_FILE, windowsWorktree.id).blocked).toBe(false)
  })

  it('treats a Windows-path project configured to run in WSL as a WSL target', () => {
    const wslProject: Project = {
      id: 'win',
      displayName: 'win',
      badgeColor: '#000000',
      sourceRepoIds: ['win'],
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
      createdAt: 1,
      updatedAt: 1
    }
    expect(
      resolveAiVaultSessionLaunchTarget({
        sessionFilePath: WSL_SESSION_FILE,
        activeWorktreeId: windowsWorktree.id,
        targetState: targetState([wslProject])
      })
    ).toEqual({ status: 'ready', worktreeId: windowsWorktree.id })
  })

  it('honors a WSL-path project pinned to the Windows host over its path', () => {
    const hostProject: Project = {
      id: 'wsl',
      displayName: 'wsl',
      badgeColor: '#000000',
      sourceRepoIds: ['wsl'],
      localWindowsRuntimePreference: { kind: 'windows-host' },
      createdAt: 1,
      updatedAt: 1
    }
    const resume = (sessionFilePath: string) =>
      resolveAiVaultSessionLaunchTarget({
        sessionFilePath,
        activeWorktreeId: wslWorktree.id,
        targetState: targetState([hostProject])
      }).status
    expect(resume(WSL_SESSION_FILE)).toBe('unsupported')
    expect(resume(WINDOWS_SESSION_FILE)).toBe('ready')
  })

  it('blocks transcripts while the project runtime requires repair', () => {
    const inheritProject: Project = {
      id: 'win',
      displayName: 'win',
      badgeColor: '#000000',
      sourceRepoIds: ['win'],
      localWindowsRuntimePreference: { kind: 'inherit-global' },
      createdAt: 1,
      updatedAt: 1
    }
    // A global WSL default without a distro leaves the project runtime repair-required.
    const state = targetState(
      [inheritProject],
      createGlobalSettingsFixture({ localWindowsRuntimeDefault: { kind: 'wsl', distro: null } })
    )
    expect(getAiVaultResumeWorkspaceWslDistro(state, windowsWorktree.id)).toBeUndefined()
    for (const sessionFilePath of [WINDOWS_SESSION_FILE, WSL_SESSION_FILE]) {
      expect(
        resolveAiVaultSessionLaunchTarget({
          sessionFilePath,
          activeWorktreeId: windowsWorktree.id,
          targetState: state
        }).status
      ).toBe('unsupported')
    }
  })

  it('blocks transcripts in a folder with several possible owning repos', () => {
    const state = targetState()
    state.folderWorkspaces = [makeFolderWorkspace({ folderPath: 'C:\\repo\\folder' })]
    state.repos = repos.map((repo) => ({ ...repo, projectGroupId: 'group-1' }))
    expect(getAiVaultResumeWorkspaceWslDistro(state, 'folder:folder-1')).toBeUndefined()
    for (const sessionFilePath of [WINDOWS_SESSION_FILE, WSL_SESSION_FILE]) {
      expect(
        resolveAiVaultSessionLaunchTarget({
          sessionFilePath,
          activeWorktreeId: 'folder:folder-1',
          targetState: state
        }).status
      ).toBe('unsupported')
    }
  })

  it('reports a direct resume into the wrong runtime as unsupported', () => {
    expect(
      resolveAiVaultSessionLaunchTarget({
        sessionFilePath: WSL_SESSION_FILE,
        activeWorktreeId: windowsWorktree.id,
        targetState: targetState()
      })
    ).toEqual({ status: 'unsupported', targetStatus: 'local' })
  })
})
