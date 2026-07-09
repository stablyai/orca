import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import {
  getLiveClaudeSessionRestartPlan,
  markClaudeSessionsForRestart
} from './claude-session-restart'
import { toRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import { getDefaultSettings } from '../../../shared/constants'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import type { Project, Repo, Worktree } from '../../../shared/types'

const ACCOUNT_LABEL = 'same@example.com'
const HOST_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const WSL_LEAF_ID = '22222222-2222-4222-8222-222222222222'

function makeRepo(args: { id: string; path: string; connectionId?: string | null }): Repo {
  return {
    id: args.id,
    path: args.path,
    displayName: args.id,
    badgeColor: '#000000',
    addedAt: 1,
    connectionId: args.connectionId ?? null
  }
}

function makeProject(args: {
  id: string
  repoId: string
  runtime: Project['localWindowsRuntimePreference']
}): Project {
  return {
    id: args.id,
    displayName: args.id,
    badgeColor: '#000000',
    sourceRepoIds: [args.repoId],
    localWindowsRuntimePreference: args.runtime,
    createdAt: 1,
    updatedAt: 1
  }
}

function makeWorktree(args: {
  id: string
  repoId: string
  projectId: string
  path: string
}): Worktree {
  return {
    id: args.id,
    repoId: args.repoId,
    projectId: args.projectId,
    displayName: args.id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    path: args.path,
    head: '',
    branch: '',
    isBare: false,
    isMainWorktree: false
  }
}

function makeTab(args: {
  id: string
  ptyId: string
  worktreeId: string
  title?: string
  launchAgent?: 'claude'
}): AppState['tabsByWorktree'][string][number] {
  return {
    id: args.id,
    ptyId: args.ptyId,
    worktreeId: args.worktreeId,
    title: args.title ?? 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...(args.launchAgent ? { launchAgent: args.launchAgent } : {})
  }
}

function makeLayout(leafId: string, ptyId: string): AppState['terminalLayoutsByTabId'][string] {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: ptyId }
  }
}

describe('Claude session restart targeting', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  beforeEach(() => {
    useAppStore.setState({
      settings: getDefaultSettings('/tmp'),
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {},
      runtimePaneTitlesByTabId: {},
      agentStatusByPaneKey: {},
      pendingClaudePaneRestartIds: {},
      claudeRestartNoticeByPtyId: {}
    })
    vi.stubGlobal('window', {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        platform: {
          ...originalWindow?.api?.platform,
          get: vi.fn(() => ({ platform: 'win32' }))
        },
        pty: {
          ...originalWindow?.api?.pty,
          getForegroundProcess: vi.fn(),
          hasChildProcesses: vi.fn().mockResolvedValue(false)
        }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('scopes WSL account switches to matching local WSL Claude PTYs', async () => {
    const hostWorktreeId = 'repo-host::C:\\repo'
    const wslWorktreeId = 'repo-wsl::C:\\repo'
    const sshWorktreeId = 'repo-ssh::/repo'
    const sshPtyId = toAppSshPtyId('target-1', 'pty-ssh')
    const runtimePtyId = toRemoteRuntimePtyId('pty-runtime', 'runtime-env')

    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/tmp'),
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      },
      projects: [
        makeProject({
          id: 'project-host',
          repoId: 'repo-host',
          runtime: { kind: 'windows-host' }
        }),
        makeProject({
          id: 'project-wsl',
          repoId: 'repo-wsl',
          runtime: { kind: 'wsl', distro: 'Ubuntu' }
        })
      ],
      repos: [
        makeRepo({ id: 'repo-host', path: 'C:\\repo' }),
        makeRepo({ id: 'repo-wsl', path: 'C:\\repo' }),
        makeRepo({ id: 'repo-ssh', path: '/repo', connectionId: 'target-1' })
      ],
      worktreesByRepo: {
        'repo-host': [
          makeWorktree({
            id: hostWorktreeId,
            repoId: 'repo-host',
            projectId: 'project-host',
            path: 'C:\\repo'
          })
        ],
        'repo-wsl': [
          makeWorktree({
            id: wslWorktreeId,
            repoId: 'repo-wsl',
            projectId: 'project-wsl',
            path: 'C:\\repo'
          })
        ],
        'repo-ssh': [
          makeWorktree({
            id: sshWorktreeId,
            repoId: 'repo-ssh',
            projectId: 'project-ssh',
            path: '/repo'
          })
        ]
      },
      tabsByWorktree: {
        [hostWorktreeId]: [
          makeTab({ id: 'tab-host', ptyId: 'pty-host', worktreeId: hostWorktreeId })
        ],
        [wslWorktreeId]: [makeTab({ id: 'tab-wsl', ptyId: 'pty-wsl', worktreeId: wslWorktreeId })],
        [sshWorktreeId]: [makeTab({ id: 'tab-ssh', ptyId: sshPtyId, worktreeId: sshWorktreeId })]
      },
      ptyIdsByTabId: {
        'tab-host': ['pty-host'],
        'tab-wsl': ['pty-wsl', runtimePtyId],
        'tab-ssh': [sshPtyId]
      },
      terminalLayoutsByTabId: {
        'tab-host': makeLayout(HOST_LEAF_ID, 'pty-host'),
        'tab-wsl': makeLayout(WSL_LEAF_ID, 'pty-wsl'),
        'tab-ssh': makeLayout(HOST_LEAF_ID, sshPtyId)
      }
    })
    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('claude')

    await expect(
      getLiveClaudeSessionRestartPlan({ target: { runtime: 'wsl', wslDistro: 'Ubuntu' } })
    ).resolves.toEqual({ livePtyIds: ['pty-wsl'], workInProgressPtyIds: [] })

    expect(window.api.pty.getForegroundProcess).toHaveBeenCalledTimes(1)
    expect(window.api.pty.getForegroundProcess).toHaveBeenCalledWith('pty-wsl')
  })

  it('does not use stale Claude tab hints when a shell is foregrounded', async () => {
    useAppStore.setState({
      tabsByWorktree: {
        wt1: [
          makeTab({
            id: 'tab-1',
            ptyId: 'pty-1',
            worktreeId: 'wt1',
            title: '. write account switcher',
            launchAgent: 'claude'
          })
        ]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      terminalLayoutsByTabId: { 'tab-1': makeLayout(HOST_LEAF_ID, 'pty-1') },
      runtimePaneTitlesByTabId: { 'tab-1': { 0: '. write account switcher' } }
    })
    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('zsh')

    await expect(getLiveClaudeSessionRestartPlan()).resolves.toEqual({
      livePtyIds: [],
      workInProgressPtyIds: []
    })
  })

  it('keeps same-label Claude accounts stale until the original account id returns', () => {
    markClaudeSessionsForRestart({
      ptyIds: ['pty-1'],
      previousAccountLabel: ACCOUNT_LABEL,
      nextAccountLabel: ACCOUNT_LABEL,
      previousAccountId: 'account-org-a',
      nextAccountId: 'account-org-b'
    })

    expect(useAppStore.getState().claudeRestartNoticeByPtyId['pty-1']).toMatchObject({
      previousAccountLabel: ACCOUNT_LABEL,
      nextAccountLabel: ACCOUNT_LABEL,
      previousAccountId: 'account-org-a',
      nextAccountId: 'account-org-b'
    })

    markClaudeSessionsForRestart({
      ptyIds: ['pty-1'],
      previousAccountLabel: ACCOUNT_LABEL,
      nextAccountLabel: ACCOUNT_LABEL,
      previousAccountId: 'account-org-b',
      nextAccountId: 'account-org-a'
    })

    expect(useAppStore.getState().claudeRestartNoticeByPtyId['pty-1']).toBeUndefined()
  })
})
