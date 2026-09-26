import { describe, expect, it, vi } from 'vitest'
import {
  selectWorktreeHooksUnverifiable,
  type WorktreeHookObservabilityState
} from './worktree-hook-observability'
import { getDefaultSettings } from '../../../../shared/constants'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Project } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { Worktree } from '../../../../shared/worktree/types'

vi.mock('@/lib/renderer-app-platform', () => ({ getRendererAppPlatform: () => 'win32' }))

const REPO_ID = 'repo-1'
const WORKTREE_ID = `${REPO_ID}::/home/user/repo/wt-1`
const FOLDER_ID = 'folder-1'
const FOLDER_WORKSPACE_ID = `folder:${FOLDER_ID}`

const NO_EVIDENCE = {
  hasPermission: false,
  hasLiveWorking: false
}

function makeTab(
  id: string,
  launchAgent?: TuiAgent,
  overrides: Partial<TerminalTab> = {}
): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: WORKTREE_ID,
    title: 'bash',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    launchAgent,
    ...overrides
  }
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: REPO_ID,
    path: '/home/user/repo',
    displayName: 'repo',
    badgeColor: '#000000',
    addedAt: 0,
    connectionId: null,
    ...overrides
  }
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: WORKTREE_ID,
    repoId: REPO_ID,
    path: '/home/user/repo/wt-1',
    head: 'abc123',
    branch: 'refs/heads/wt-1',
    isBare: false,
    isMainWorktree: false,
    displayName: 'wt-1',
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

function makeFolderWorkspace(folderPath: string): FolderWorkspace {
  return {
    id: FOLDER_ID,
    projectGroupId: 'group-1',
    name: 'project',
    folderPath,
    connectionId: null,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: REPO_ID,
    displayName: 'repo',
    badgeColor: '#000000',
    sourceRepoIds: [REPO_ID],
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function makeSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    ...getDefaultSettings('/home/user'),
    agentStatusHooksEnabled: true,
    disabledTuiAgents: [],
    ...overrides
  }
}

function makeState(
  overrides: Partial<WorktreeHookObservabilityState> = {}
): WorktreeHookObservabilityState {
  return {
    agentHookInstallStateByTarget: { claude: 'not_installed' },
    tabsByWorktree: { [WORKTREE_ID]: [makeTab('tab-1', 'claude')] },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    worktreesByRepo: { [REPO_ID]: [makeWorktree()] },
    repos: [makeRepo()],
    projectGroups: [],
    folderWorkspaces: [],
    activeRepoId: REPO_ID,
    activeWorktreeId: WORKTREE_ID,
    projects: [],
    settings: makeSettings(),
    ...overrides
  }
}

describe('selectWorktreeHooksUnverifiable', () => {
  it('flags a live Claude pane whose managed hooks were removed', () => {
    expect(selectWorktreeHooksUnverifiable(makeState(), WORKTREE_ID, NO_EVIDENCE)).toBe(true)
  })

  it('does not flag when the hooks are installed', () => {
    const state = makeState({
      agentHookInstallStateByTarget: { claude: 'installed' }
    })

    expect(selectWorktreeHooksUnverifiable(state, WORKTREE_ID, NO_EVIDENCE)).toBe(false)
  })

  it('does not flag before the install snapshot has been read', () => {
    const state = makeState({ agentHookInstallStateByTarget: {} })

    expect(selectWorktreeHooksUnverifiable(state, WORKTREE_ID, NO_EVIDENCE)).toBe(false)
  })

  it('does not flag before settings have hydrated', () => {
    const state = makeState({ settings: null })

    expect(selectWorktreeHooksUnverifiable(state, WORKTREE_ID, NO_EVIDENCE)).toBe(false)
  })

  it('does not flag when managed status hooks are disabled', () => {
    const state = makeState({ settings: makeSettings({ agentStatusHooksEnabled: false }) })

    expect(selectWorktreeHooksUnverifiable(state, WORKTREE_ID, NO_EVIDENCE)).toBe(false)
  })

  it('does not flag an agent disabled in Settings', () => {
    const state = makeState({ settings: makeSettings({ disabledTuiAgents: ['claude'] }) })

    expect(selectWorktreeHooksUnverifiable(state, WORKTREE_ID, NO_EVIDENCE)).toBe(false)
  })

  it('does not flag a tab whose pty is dead — a slept worktree claims nothing', () => {
    const state = makeState({ ptyIdsByTabId: { 'tab-1': [] } })

    expect(selectWorktreeHooksUnverifiable(state, WORKTREE_ID, NO_EVIDENCE)).toBe(false)
  })

  it('does not flag an agent that never had managed hooks', () => {
    const state = makeState({
      tabsByWorktree: { [WORKTREE_ID]: [makeTab('tab-1', 'opencode')] }
    })

    expect(selectWorktreeHooksUnverifiable(state, WORKTREE_ID, NO_EVIDENCE)).toBe(false)
  })

  it('is vetoed by a pane that is reporting right now', () => {
    expect(
      selectWorktreeHooksUnverifiable(makeState(), WORKTREE_ID, {
        ...NO_EVIDENCE,
        hasLiveWorking: true
      })
    ).toBe(false)
  })

  it('flags hooks removed after the pane last reported done', () => {
    expect(selectWorktreeHooksUnverifiable(makeState(), WORKTREE_ID, NO_EVIDENCE)).toBe(true)
  })

  it('declines to judge an SSH worktree from the local hook config', () => {
    const state = makeState({ repos: [makeRepo({ connectionId: 'ssh-1' })] })

    expect(selectWorktreeHooksUnverifiable(state, WORKTREE_ID, NO_EVIDENCE)).toBe(false)
  })

  it('declines to judge a WSL worktree — hooks live inside the distro', () => {
    const state = makeState({
      worktreesByRepo: {
        [REPO_ID]: [makeWorktree({ path: '\\\\wsl$\\Ubuntu\\home\\user\\repo' })]
      }
    })

    expect(selectWorktreeHooksUnverifiable(state, WORKTREE_ID, NO_EVIDENCE)).toBe(false)
  })

  it('declines a Windows-path worktree configured to execute in WSL', () => {
    const state = makeState({
      projects: [makeProject({ localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' } })]
    })

    expect(selectWorktreeHooksUnverifiable(state, WORKTREE_ID, NO_EVIDENCE)).toBe(false)
  })

  it('declines a pane owned by a remote runtime in a local worktree', () => {
    const state = makeState({ ptyIdsByTabId: { 'tab-1': ['remote:runtime-1@@pty-1'] } })

    expect(selectWorktreeHooksUnverifiable(state, WORKTREE_ID, NO_EVIDENCE)).toBe(false)
  })

  it('declines a pane launched from a WSL startup directory', () => {
    const state = makeState({
      tabsByWorktree: {
        [WORKTREE_ID]: [
          makeTab('tab-1', 'claude', {
            startupCwd: '\\\\wsl.localhost\\Ubuntu\\home\\user\\repo'
          })
        ]
      }
    })

    expect(selectWorktreeHooksUnverifiable(state, WORKTREE_ID, NO_EVIDENCE)).toBe(false)
  })

  it('flags a local folder workspace when its live agent hooks are missing', () => {
    const state = makeState({
      tabsByWorktree: { [FOLDER_WORKSPACE_ID]: [makeTab('folder-tab', 'claude')] },
      ptyIdsByTabId: { 'folder-tab': ['folder-pty'] },
      folderWorkspaces: [makeFolderWorkspace('/home/user/project')]
    })

    expect(selectWorktreeHooksUnverifiable(state, FOLDER_WORKSPACE_ID, NO_EVIDENCE)).toBe(true)
  })

  it('declines to judge a WSL folder workspace from native hook config', () => {
    const state = makeState({
      tabsByWorktree: { [FOLDER_WORKSPACE_ID]: [makeTab('folder-tab', 'claude')] },
      ptyIdsByTabId: { 'folder-tab': ['folder-pty'] },
      folderWorkspaces: [makeFolderWorkspace('\\\\wsl$\\Ubuntu\\home\\user\\project')]
    })

    expect(selectWorktreeHooksUnverifiable(state, FOLDER_WORKSPACE_ID, NO_EVIDENCE)).toBe(false)
  })

  it('flags when only one of several live agents is blind', () => {
    const state = makeState({
      tabsByWorktree: {
        [WORKTREE_ID]: [makeTab('tab-1', 'codex'), makeTab('tab-2', 'claude')]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'], 'tab-2': ['pty-2'] },
      agentHookInstallStateByTarget: {
        codex: 'installed',
        claude: 'not_installed'
      }
    })

    expect(selectWorktreeHooksUnverifiable(state, WORKTREE_ID, NO_EVIDENCE)).toBe(true)
  })

  it('returns false for a worktree with no tabs', () => {
    const state = makeState({ tabsByWorktree: {} })

    expect(selectWorktreeHooksUnverifiable(state, WORKTREE_ID, NO_EVIDENCE)).toBe(false)
  })
})
