import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { WorkspacePortScanResult } from '../../../shared/workspace-ports'
import {
  openHttpLink,
  openOwnedHttpLink,
  registerHttpLinkStoreAccessor,
  registerWorkspaceHttpLinkBrowserOpener,
  resolveLocalhostHttpLinkDisplayUrl
} from './http-link-routing'

import type { ExecutionHostId } from '../../../shared/execution-host'

const toastErrorMock = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({ toast: { error: toastErrorMock } }))

const openUrlMock = vi.fn()
const registerLocalhostLabelMock = vi.fn()
const setActiveWorktreeMock = vi.fn()
const createBrowserTabMock = vi.fn()
const setActiveViewMock = vi.fn()
const openRuntimeBrowserTabMock = vi.fn((): Promise<string | null> => Promise.resolve(null))
const dispatchEventMock = vi.fn()

function noActiveWorkspace(): {
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
} {
  return { activeWorktreeId: null, activeWorkspaceExecutionHostId: null }
}

type LinkTestSettings = {
  openLinksInApp?: boolean
  openLinksInAppModifierInverts?: boolean
  openLinksInAppInBackground?: boolean
  openLinksInAppPreferencePrompted?: boolean
  activeRuntimeEnvironmentId?: string | null
  localhostWorktreeLabelsEnabled?: boolean
}
const noSettings = (): LinkTestSettings | undefined => undefined
const terminalView = (): 'terminal' | 'activity' => 'terminal'

const repos: { id: string; displayName: string; repoIcon?: null; badgeColor?: string }[] = []

const projects: { id: string; displayName: string; repoIcon?: null; badgeColor?: string }[] = []

const storeState = {
  settings: noSettings(),
  setActiveWorktree: setActiveWorktreeMock,
  activeView: terminalView(),
  setActiveView: setActiveViewMock,
  ...noActiveWorkspace(),
  createBrowserTab: createBrowserTabMock,
  repos,
  projects,
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
  storeState.activeView = 'terminal'
  Object.assign(storeState, noActiveWorkspace())
  storeState.workspacePortScansByKey = {}
  registerHttpLinkStoreAccessor(() => storeState)
  registerWorkspaceHttpLinkBrowserOpener(openRuntimeBrowserTabMock)
  vi.stubGlobal('window', {
    dispatchEvent: dispatchEventMock,
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
  registerWorkspaceHttpLinkBrowserOpener(null)
  vi.unstubAllGlobals()
})

describe('openHttpLink', () => {
  it.each([
    { kind: 'local' },
    { kind: 'runtime', runtimeEnvironmentId: 'env-1' },
    { kind: 'ssh', connectionId: 'ssh-1' }
  ] as const)('opens required owner %j without reading Active Server', (sourceOwner) => {
    storeState.settings = {
      openLinksInApp: true,
      localhostWorktreeLabelsEnabled: true,
      get activeRuntimeEnvironmentId(): never {
        throw new Error('An owned link must not read Active Server')
      }
    }
    openOwnedHttpLink('http://localhost:5180/', {
      worktreeId: 'wt-1',
      allowRemoteInApp: true,
      sourceOwner
    })
    expect(openRuntimeBrowserTabMock).toHaveBeenCalledExactlyOnceWith({
      workspaceId: 'wt-1',
      url: 'http://localhost:5180/',
      intent: { kind: 'url' },
      linkContext: expect.objectContaining({ linkIntent: null, canReveal: expect.any(Function) }),
      ...(sourceOwner.kind === 'runtime'
        ? { expectedRuntimeEnvironmentId: 'env-1' }
        : sourceOwner.kind === 'ssh'
          ? { expectedSshConnectionId: 'ssh-1' }
          : {})
    })
    expect(openUrlMock).not.toHaveBeenCalled()
    expect(registerLocalhostLabelMock).not.toHaveBeenCalled()
  })
  it('keeps the selected host of the active workspace a link opens in', () => {
    registerWorkspaceHttpLinkBrowserOpener(null)
    storeState.settings = { openLinksInApp: true }
    storeState.activeWorktreeId = 'wt-1'
    storeState.activeWorkspaceExecutionHostId = 'ssh:box'

    openHttpLink('https://example.com/', { worktreeId: 'wt-1' })

    expect(setActiveWorktreeMock).toHaveBeenCalledWith('wt-1', 'ssh:box')
  })

  it('routes floating workspace links into Orca without changing the active repo worktree', () => {
    registerWorkspaceHttpLinkBrowserOpener(null)
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

  it('honors an explicit local document owner despite an unrelated active runtime', () => {
    registerWorkspaceHttpLinkBrowserOpener(null)
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

  it('routes runtime and SSH document owners through their workspace browsers', () => {
    storeState.settings = { openLinksInApp: true, localhostWorktreeLabelsEnabled: true }

    openHttpLink('http://localhost:5180/runtime', {
      allowRemoteInApp: true,
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'runtime', runtimeEnvironmentId: 'env-1' }
    })
    openHttpLink('http://localhost:5180/ssh', {
      allowRemoteInApp: true,
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'ssh', connectionId: 'ssh-1' }
    })

    expect(openRuntimeBrowserTabMock).toHaveBeenNthCalledWith(1, {
      workspaceId: 'wt-1',
      url: 'http://localhost:5180/runtime',
      intent: { kind: 'url' },
      expectedRuntimeEnvironmentId: 'env-1',
      linkContext: expect.objectContaining({ linkIntent: null, canReveal: expect.any(Function) })
    })
    expect(openRuntimeBrowserTabMock).toHaveBeenNthCalledWith(2, {
      workspaceId: 'wt-1',
      url: 'http://localhost:5180/ssh',
      intent: { kind: 'url' },
      expectedSshConnectionId: 'ssh-1',
      linkContext: expect.objectContaining({ linkIntent: null, canReveal: expect.any(Function) })
    })
    expect(openUrlMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(registerLocalhostLabelMock).not.toHaveBeenCalled()
  })

  it('fails closed instead of falling back to the client system browser', async () => {
    storeState.settings = { openLinksInApp: true }
    openRuntimeBrowserTabMock.mockRejectedValueOnce(new Error('runtime unavailable'))

    openHttpLink('https://example.com/', {
      allowRemoteInApp: true,
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'runtime', runtimeEnvironmentId: 'env-1' }
    })

    await vi.waitFor(() => expect(openRuntimeBrowserTabMock).toHaveBeenCalledOnce())
    expect(openUrlMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalledWith('runtime unavailable')
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

  // Hover labels must match clicks: remote loopback opens raw in the system browser, never under a local workspace label.
  it.each([
    ['runtime', { kind: 'runtime', runtimeEnvironmentId: 'env-1' }] as const,
    ['ssh', { kind: 'ssh', connectionId: 'conn-1' }] as const
  ])('does not label a %s-owned localhost link without an active runtime', async (_kind, owner) => {
    storeState.settings = {
      localhostWorktreeLabelsEnabled: true,
      activeRuntimeEnvironmentId: null
    }
    storeState.repos = [{ id: 'repo-1', displayName: 'snapstudio' }]
    storeState.worktreesByRepo = { 'repo-1': [{ id: 'wt-main', projectId: 'repo-1' }] }
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

    await expect(resolveLocalhostHttpLinkDisplayUrl('http://localhost:5180/', owner)).resolves.toBe(
      null
    )
    expect(registerLocalhostLabelMock).not.toHaveBeenCalled()
  })
})
