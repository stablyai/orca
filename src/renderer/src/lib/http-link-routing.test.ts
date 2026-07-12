import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { WorkspacePortScanResult } from '../../../shared/workspace-ports'
import {
  openHttpLink,
  registerHttpLinkStoreAccessor,
  resolveLocalhostHttpLinkDisplayUrl
} from './http-link-routing'

const openUrlMock = vi.fn()
const registerLocalhostLabelMock = vi.fn()
const setActiveWorktreeMock = vi.fn()
const createBrowserTabMock = vi.fn()

const storeState = {
  settings: undefined as
    | {
        openLinksInApp?: boolean
        openLinksInAppPreferencePrompted?: boolean
        activeRuntimeEnvironmentId?: string | null
        localhostWorktreeLabelsEnabled?: boolean
      }
    | undefined,
  setActiveWorktree: setActiveWorktreeMock,
  createBrowserTab: createBrowserTabMock,
  repos: [] as { id: string; displayName: string; repoIcon?: null; badgeColor?: string }[],
  projects: [] as { id: string; displayName: string; repoIcon?: null; badgeColor?: string }[],
  worktreesByRepo: {} as Record<
    string,
    { id: string; projectId?: string; repoId?: string; displayName?: string }[]
  >,
  allWorktrees: vi.fn(
    () => [] as { id: string; projectId?: string; repoId?: string; displayName?: string }[]
  ),
  workspacePortScan: null as { result: WorkspacePortScanResult } | null,
  workspacePortScansByKey: {} as Record<string, WorkspacePortScanResult>
}

beforeEach(() => {
  vi.clearAllMocks()
  storeState.settings = undefined
  storeState.workspacePortScansByKey = {}
  registerHttpLinkStoreAccessor(() => storeState)
  vi.stubGlobal('window', {
    api: {
      shell: {
        openUrl: openUrlMock
      },
      localhostWorktreeLabels: {
        register: registerLocalhostLabelMock
      }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('openHttpLink', () => {
  it('routes into Orca when openLinksInApp is on and a worktree is known', () => {
    storeState.settings = { openLinksInApp: true }

    openHttpLink('https://example.com/', { worktreeId: 'wt-1' })

    expect(setActiveWorktreeMock).toHaveBeenCalledWith('wt-1')
    expect(createBrowserTabMock).toHaveBeenCalledWith('wt-1', 'https://example.com/', {
      activate: true
    })
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it('defaults to the system browser when settings have not hydrated', () => {
    storeState.settings = undefined

    openHttpLink('https://example.com/', { worktreeId: 'wt-1' })

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('routes floating workspace links into Orca without changing the active repo worktree', () => {
    storeState.settings = { openLinksInApp: true }

    openHttpLink('https://example.com/', { worktreeId: FLOATING_TERMINAL_WORKTREE_ID })

    expect(setActiveWorktreeMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).toHaveBeenCalledWith(
      FLOATING_TERMINAL_WORKTREE_ID,
      'https://example.com/',
      { activate: true }
    )
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it('routes to the system browser when openLinksInApp is off', () => {
    storeState.settings = { openLinksInApp: false }

    openHttpLink('https://example.com/', { worktreeId: 'wt-1' })

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('routes to the system browser when a remote runtime environment is active', () => {
    storeState.settings = { openLinksInApp: true, activeRuntimeEnvironmentId: 'env-1' }

    openHttpLink('https://example.com/', { worktreeId: 'wt-1' })

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(setActiveWorktreeMock).not.toHaveBeenCalled()
  })

  it('honors an explicit local document owner despite an unrelated active runtime', () => {
    storeState.settings = { openLinksInApp: true, activeRuntimeEnvironmentId: 'env-other' }

    openHttpLink('https://example.com/', {
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'local' }
    })

    expect(createBrowserTabMock).toHaveBeenCalledWith('wt-1', 'https://example.com/', {
      activate: true
    })
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it('routes explicit runtime and SSH document owners to the exact system URL', () => {
    storeState.settings = { openLinksInApp: true, localhostWorktreeLabelsEnabled: true }

    openHttpLink('http://localhost:5180/runtime', {
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'runtime', runtimeEnvironmentId: 'env-1' }
    })
    openHttpLink('http://localhost:5180/ssh', {
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'ssh', connectionId: 'ssh-1' }
    })

    expect(openUrlMock).toHaveBeenNthCalledWith(1, 'http://localhost:5180/runtime')
    expect(openUrlMock).toHaveBeenNthCalledWith(2, 'http://localhost:5180/ssh')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(registerLocalhostLabelMock).not.toHaveBeenCalled()
  })

  it('labels explicit local links from the local scan instead of a merged remote port', async () => {
    storeState.settings = {
      openLinksInApp: true,
      activeRuntimeEnvironmentId: 'env-other',
      localhostWorktreeLabelsEnabled: true
    }
    storeState.repos = [
      { id: 'repo-local', displayName: 'Local' },
      { id: 'repo-remote', displayName: 'Remote' }
    ]
    storeState.worktreesByRepo = {
      'repo-local': [{ id: 'wt-local', projectId: 'repo-local' }],
      'repo-remote': [{ id: 'wt-remote', projectId: 'repo-remote' }]
    }
    const port = (repoId: string, worktreeId: string, path: string) => ({
      id: `tcp:5180:${worktreeId}`,
      kind: 'workspace' as const,
      port: 5180,
      protocol: 'http' as const,
      bindHost: '127.0.0.1',
      connectHost: 'localhost',
      owner: {
        repoId,
        worktreeId,
        displayName: worktreeId,
        path,
        confidence: 'cwd' as const
      }
    })
    storeState.workspacePortScan = {
      result: {
        platform: 'darwin',
        scannedAt: 2,
        ports: [port('repo-remote', 'wt-remote', '/remote')]
      }
    }
    storeState.workspacePortScansByKey = {
      'local:all': {
        platform: 'darwin',
        scannedAt: 1,
        ports: [port('repo-local', 'wt-local', '/local')]
      }
    }
    registerLocalhostLabelMock.mockResolvedValue({ url: 'http://wt-local.orca.localhost:60016/' })

    openHttpLink('http://localhost:5180/', {
      worktreeId: 'wt-local',
      sourceOwner: { kind: 'local' }
    })
    await Promise.resolve()

    expect(registerLocalhostLabelMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: 'repo-local', worktreeId: 'wt-local' })
    )
  })

  it('keeps unresolved document ownership non-actionable', () => {
    storeState.settings = { openLinksInApp: true }

    openHttpLink('https://example.com/', {
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'unknown' }
    })

    expect(openUrlMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('routes to the system browser when no worktree id is provided', () => {
    storeState.settings = { openLinksInApp: true }

    openHttpLink('https://example.com/', { worktreeId: '' })

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('forceSystemBrowser overrides the setting even when a worktree is active', () => {
    storeState.settings = { openLinksInApp: true }

    openHttpLink('https://example.com/', { worktreeId: 'wt-1', forceSystemBrowser: true })

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(setActiveWorktreeMock).not.toHaveBeenCalled()
  })

  it('labels localhost links from terminal output before opening the system browser', async () => {
    storeState.settings = { openLinksInApp: false, localhostWorktreeLabelsEnabled: true }
    storeState.repos = [
      {
        id: 'repo-1',
        displayName: 'snapstudio',
        repoIcon: null,
        badgeColor: '#f97316'
      }
    ]
    storeState.worktreesByRepo = {
      'repo-1': [
        {
          id: 'wt-analytics',
          repoId: 'repo-1',
          projectId: 'repo-1',
          displayName: 'analytics'
        }
      ]
    }
    storeState.workspacePortScan = {
      result: {
        platform: 'darwin',
        scannedAt: 1,
        ports: [
          {
            id: 'tcp:5180',
            kind: 'workspace',
            port: 5180,
            protocol: 'http',
            bindHost: '127.0.0.1',
            connectHost: 'localhost',
            owner: {
              repoId: 'repo-1',
              worktreeId: 'wt-analytics',
              displayName: 'analytics',
              path: '/repo/analytics',
              confidence: 'cwd'
            }
          }
        ]
      }
    }
    registerLocalhostLabelMock.mockResolvedValue({
      url: 'http://analytics.orca.localhost:60016/episodes'
    })

    openHttpLink('http://localhost:5180/episodes', { worktreeId: 'wt-analytics' })
    await Promise.resolve()

    expect(registerLocalhostLabelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetUrl: 'http://localhost:5180/episodes',
        projectName: 'snapstudio',
        worktreeName: 'analytics',
        worktreePath: '/repo/analytics',
        worktreeId: 'wt-analytics'
      })
    )
    expect(openUrlMock).toHaveBeenCalledWith('http://analytics.orca.localhost:60016/episodes')
  })

  it('resolves display URLs for labeled localhost links without opening them', async () => {
    storeState.settings = { localhostWorktreeLabelsEnabled: true }
    storeState.repos = [
      {
        id: 'repo-1',
        displayName: 'snapstudio',
        repoIcon: null,
        badgeColor: '#f97316'
      }
    ]
    storeState.worktreesByRepo = {
      'repo-1': [
        {
          id: 'wt-main',
          repoId: 'repo-1',
          projectId: 'repo-1',
          displayName: 'main'
        }
      ]
    }
    storeState.workspacePortScan = {
      result: {
        platform: 'darwin',
        scannedAt: 1,
        ports: [
          {
            id: 'tcp:5180',
            kind: 'workspace',
            port: 5180,
            protocol: 'http',
            bindHost: '127.0.0.1',
            connectHost: 'localhost',
            owner: {
              repoId: 'repo-1',
              worktreeId: 'wt-main',
              displayName: 'main',
              path: '/repo/main',
              confidence: 'cwd'
            }
          }
        ]
      }
    }
    registerLocalhostLabelMock.mockResolvedValue({
      url: 'http://snapstudio-main.orca.localhost:60016/'
    })

    await expect(resolveLocalhostHttpLinkDisplayUrl('http://localhost:5180/')).resolves.toBe(
      'http://snapstudio-main.orca.localhost:60016/'
    )
    expect(openUrlMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('does not label localhost links while a remote runtime is active', async () => {
    storeState.settings = {
      localhostWorktreeLabelsEnabled: true,
      activeRuntimeEnvironmentId: 'web-runtime'
    }
    storeState.workspacePortScan = {
      result: {
        platform: 'darwin',
        scannedAt: 1,
        ports: [
          {
            id: 'tcp:5180',
            kind: 'workspace',
            port: 5180,
            protocol: 'http',
            bindHost: '127.0.0.1',
            connectHost: 'localhost',
            owner: {
              repoId: 'repo-1',
              worktreeId: 'wt-main',
              displayName: 'main',
              path: '/repo/main',
              confidence: 'cwd'
            }
          }
        ]
      }
    }

    await expect(resolveLocalhostHttpLinkDisplayUrl('http://localhost:5180/')).resolves.toBe(null)
    expect(registerLocalhostLabelMock).not.toHaveBeenCalled()
  })
})
