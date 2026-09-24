import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { WorkspacePortScanResult } from '../../../shared/workspace-ports'
import { makeTabGroup, makeUnifiedTab } from '../store/slices/store-test-helpers'
import type { VisibleBrowserLinkState } from './visible-browser-link-target'
import {
  openHttpLink,
  registerHttpLinkStoreAccessor,
  registerWorkspaceHttpLinkBrowserOpener,
  resolveLocalhostHttpLinkDisplayUrl
} from './http-link-routing'

const toastErrorMock = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({ toast: { error: toastErrorMock } }))

const openUrlMock = vi.fn()
const registerLocalhostLabelMock = vi.fn()
const setActiveWorktreeMock = vi.fn()
const createBrowserTabMock = vi.fn()
const focusGroupMock = vi.fn()
const openRuntimeBrowserTabMock = vi.fn(() => Promise.resolve())

const emptyTabLayout: Required<VisibleBrowserLinkState> = {
  layoutByWorktree: {},
  groupsByWorktree: {},
  unifiedTabsByWorktree: {},
  activeGroupIdByWorktree: {}
}

const storeState = {
  settings: undefined as
    | {
        openLinksInApp?: boolean
        openLinksInAppModifierInverts?: boolean
        openLinksInAppPreferencePrompted?: boolean
        activeRuntimeEnvironmentId?: string | null
        localhostWorktreeLabelsEnabled?: boolean
      }
    | undefined,
  setActiveWorktree: setActiveWorktreeMock,
  createBrowserTab: createBrowserTabMock,
  focusGroup: focusGroupMock,
  ...emptyTabLayout,
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
  storeState.layoutByWorktree = {}
  storeState.groupsByWorktree = {}
  storeState.unifiedTabsByWorktree = {}
  storeState.activeGroupIdByWorktree = {}
  focusGroupMock.mockReset()
  registerHttpLinkStoreAccessor(() => storeState)
  registerWorkspaceHttpLinkBrowserOpener(openRuntimeBrowserTabMock)
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
  registerWorkspaceHttpLinkBrowserOpener(null)
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

  it('forceInApp opens a local link in Orca when the setting is off', () => {
    storeState.settings = { openLinksInApp: false }

    openHttpLink('https://example.com/', {
      worktreeId: 'wt-1',
      forceInApp: true,
      sourceOwner: { kind: 'local' }
    })

    expect(createBrowserTabMock).toHaveBeenCalledWith('wt-1', 'https://example.com/', {
      activate: true
    })
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it('does not force a remote link into the Orca browser', () => {
    storeState.settings = { openLinksInApp: false }

    openHttpLink('https://example.com/', {
      worktreeId: 'wt-1',
      forceInApp: true,
      sourceOwner: { kind: 'ssh', connectionId: 'ssh-1' }
    })

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('keeps explicitly local links local while a remote runtime is active', () => {
    storeState.settings = { openLinksInApp: true, activeRuntimeEnvironmentId: 'remote-1' }

    openHttpLink('https://example.com/', {
      worktreeId: 'wt-1',
      allowRemoteInApp: true,
      sourceOwner: { kind: 'local' }
    })

    expect(createBrowserTabMock).toHaveBeenCalledWith('wt-1', 'https://example.com/', {
      activate: true
    })
    expect(openRuntimeBrowserTabMock).not.toHaveBeenCalled()
  })

  it('routes opted-in links without a source owner through the active runtime', () => {
    storeState.settings = {
      openLinksInApp: true,
      activeRuntimeEnvironmentId: ' remote-1 '
    }

    openHttpLink('https://github.com/acme/widgets/pull/123', {
      worktreeId: 'wt-1',
      allowRemoteInApp: true
    })

    expect(openRuntimeBrowserTabMock).toHaveBeenCalledExactlyOnceWith({
      workspaceId: 'wt-1',
      url: 'https://github.com/acme/widgets/pull/123',
      intent: { kind: 'url' }
    })
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(openUrlMock).not.toHaveBeenCalled()
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
      expectedRuntimeEnvironmentId: 'env-1'
    })
    expect(openRuntimeBrowserTabMock).toHaveBeenNthCalledWith(2, {
      workspaceId: 'wt-1',
      url: 'http://localhost:5180/ssh',
      intent: { kind: 'url' },
      expectedSshConnectionId: 'ssh-1'
    })
    expect(openUrlMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(registerLocalhostLabelMock).not.toHaveBeenCalled()
  })

  // Why: runtimes bind per workspace, so activeRuntimeEnvironmentId is commonly
  // null while a pane is remote — ownership must come from the click source.
  it('uses the pane runtime owner when no runtime is globally active', () => {
    storeState.settings = { openLinksInApp: true, activeRuntimeEnvironmentId: null }

    openHttpLink('https://example.com/', {
      allowRemoteInApp: true,
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'runtime', runtimeEnvironmentId: 'env-1' }
    })

    expect(openRuntimeBrowserTabMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRuntimeEnvironmentId: 'env-1' })
    )
    expect(openUrlMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(setActiveWorktreeMock).not.toHaveBeenCalled()
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

  it('keeps an explicit runtime system-browser action on the viewing client', () => {
    storeState.settings = { openLinksInApp: true }

    openHttpLink('https://example.com/', {
      worktreeId: 'wt-1',
      forceSystemBrowser: true,
      sourceOwner: { kind: 'runtime', runtimeEnvironmentId: 'env-1' }
    })

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(openRuntimeBrowserTabMock).not.toHaveBeenCalled()
  })

  it('keeps generic runtime-owned document links in the system browser', () => {
    storeState.settings = { openLinksInApp: true }

    openHttpLink('https://example.com/', {
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'runtime', runtimeEnvironmentId: 'env-1' }
    })

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(openRuntimeBrowserTabMock).not.toHaveBeenCalled()
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

  // Why: the hover label must describe the click's real destination — a remote pane's
  // loopback URL opens raw in the system browser, so a local worktree label would lie.
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

  // Why: a local pane keeps its label from the local scan even while another pane's
  // runtime is globally active — the same scan the click resolves.
  it('labels a local-owned localhost link from the local scan', async () => {
    storeState.settings = {
      localhostWorktreeLabelsEnabled: true,
      activeRuntimeEnvironmentId: 'env-other'
    }
    storeState.repos = [{ id: 'repo-1', displayName: 'snapstudio' }]
    storeState.worktreesByRepo = { 'repo-1': [{ id: 'wt-main', projectId: 'repo-1' }] }
    storeState.workspacePortScansByKey = {
      'local:all': {
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

    await expect(
      resolveLocalhostHttpLinkDisplayUrl('http://localhost:5180/', { kind: 'local' })
    ).resolves.toBe('http://snapstudio-main.orca.localhost:60016/')
  })
})

describe('openHttpLink modifier routing', () => {
  it('forces the system browser when inverting is off and links open in Orca', () => {
    storeState.settings = { openLinksInApp: true, openLinksInAppModifierInverts: false }

    openHttpLink('https://example.com/', { worktreeId: 'wt-1', modifierHeld: true })

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  // Why: this is the pre-existing dead gesture — Shift already meant "system
  // browser", which is where the link was going anyway.
  it('stays on the system browser when inverting is off and links open externally', () => {
    storeState.settings = { openLinksInApp: false, openLinksInAppModifierInverts: false }

    openHttpLink('https://example.com/', { worktreeId: 'wt-1', modifierHeld: true })

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('opens in Orca when inverting is on and links open externally', () => {
    storeState.settings = { openLinksInApp: false, openLinksInAppModifierInverts: true }

    openHttpLink('https://example.com/', { worktreeId: 'wt-1', modifierHeld: true })

    expect(setActiveWorktreeMock).toHaveBeenCalledWith('wt-1')
    expect(createBrowserTabMock).toHaveBeenCalledWith('wt-1', 'https://example.com/', {
      activate: true
    })
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it('opens in the system browser when inverting is on and links open in Orca', () => {
    storeState.settings = { openLinksInApp: true, openLinksInAppModifierInverts: true }

    openHttpLink('https://example.com/', { worktreeId: 'wt-1', modifierHeld: true })

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('leaves unmodified clicks on the setting', () => {
    storeState.settings = { openLinksInApp: false, openLinksInAppModifierInverts: true }

    openHttpLink('https://example.com/', { worktreeId: 'wt-1' })

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  // Why: remote-owned links must never land in an Orca tab that cannot reach them.
  it('never routes a remote source into Orca even when inverting', () => {
    storeState.settings = { openLinksInApp: false, openLinksInAppModifierInverts: true }

    openHttpLink('https://example.com/', {
      worktreeId: 'wt-1',
      modifierHeld: true,
      sourceOwner: { kind: 'ssh', connectionId: 'conn-1' }
    })

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('keeps forceSystemBrowser unconditional', () => {
    storeState.settings = { openLinksInApp: true, openLinksInAppModifierInverts: true }

    openHttpLink('https://example.com/', { worktreeId: 'wt-1', forceSystemBrowser: true })

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })
})

function showBrowserBesideTerminal(wt = 'wt-1'): void {
  storeState.layoutByWorktree = {
    [wt]: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'term' },
      second: { type: 'leaf', groupId: 'web' }
    }
  }
  storeState.groupsByWorktree = {
    [wt]: [
      makeTabGroup({ id: 'term', worktreeId: wt, activeTabId: 't1', tabOrder: ['t1'] }),
      makeTabGroup({ id: 'web', worktreeId: wt, activeTabId: 'b1', tabOrder: ['b1'] })
    ]
  }
  storeState.unifiedTabsByWorktree = {
    [wt]: [
      makeUnifiedTab({ id: 't1', worktreeId: wt, groupId: 'term', contentType: 'terminal' }),
      makeUnifiedTab({ id: 'b1', worktreeId: wt, groupId: 'web', contentType: 'browser' })
    ]
  }
  storeState.activeGroupIdByWorktree = { [wt]: 'term' }
}
const PLACED = { activate: true, targetGroupId: 'web', placementFixed: true }

describe('openHttpLink with a browser on screen', () => {
  it('opens a local link as a new tab in the visible browser group, then focuses it', () => {
    storeState.settings = { openLinksInApp: true }
    showBrowserBesideTerminal()
    openHttpLink('https://example.com/', { worktreeId: 'wt-1' })
    expect(createBrowserTabMock).toHaveBeenCalledExactlyOnceWith(
      'wt-1',
      'https://example.com/',
      PLACED
    )
    expect(focusGroupMock).toHaveBeenCalledExactlyOnceWith('wt-1', 'web')
    expect(focusGroupMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      createBrowserTabMock.mock.invocationCallOrder[0]
    )
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it('still places the tab when the accessor has no focusGroup', () => {
    storeState.settings = { openLinksInApp: true }
    showBrowserBesideTerminal()
    const { focusGroup: _omit, ...withoutFocus } = storeState
    registerHttpLinkStoreAccessor(() => withoutFocus)
    openHttpLink('https://example.com/', { worktreeId: 'wt-1' })
    expect(createBrowserTabMock).toHaveBeenCalledWith('wt-1', 'https://example.com/', PLACED)
    registerHttpLinkStoreAccessor(() => storeState)
  })

  it('keeps today placement with no focus call when the browser is hidden', () => {
    storeState.settings = { openLinksInApp: true }
    showBrowserBesideTerminal()
    storeState.groupsByWorktree['wt-1']![1] = makeTabGroup({
      id: 'web',
      worktreeId: 'wt-1',
      activeTabId: null,
      tabOrder: ['b1']
    })
    openHttpLink('https://example.com/', { worktreeId: 'wt-1' })
    expect(createBrowserTabMock).toHaveBeenCalledWith('wt-1', 'https://example.com/', {
      activate: true
    })
    expect(focusGroupMock).not.toHaveBeenCalled()
  })

  it('leaves groups alone when the link goes to the system browser', () => {
    storeState.settings = { openLinksInApp: false }
    showBrowserBesideTerminal()
    openHttpLink('https://example.com/', { worktreeId: 'wt-1' })
    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(focusGroupMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('leaves groups alone when the modifier sends the link to the system browser', () => {
    storeState.settings = { openLinksInApp: true }
    showBrowserBesideTerminal()
    openHttpLink('https://example.com/', { worktreeId: 'wt-1', modifierHeld: true })
    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(focusGroupMock).not.toHaveBeenCalled()
  })

  it('targets the floating workspace’s own browser without selecting it', () => {
    storeState.settings = { openLinksInApp: true }
    showBrowserBesideTerminal(FLOATING_TERMINAL_WORKTREE_ID)
    openHttpLink('https://example.com/', { worktreeId: FLOATING_TERMINAL_WORKTREE_ID })
    expect(createBrowserTabMock).toHaveBeenCalledWith(
      FLOATING_TERMINAL_WORKTREE_ID,
      'https://example.com/',
      PLACED
    )
    expect(setActiveWorktreeMock).not.toHaveBeenCalled()
  })

  it('computes placement when a delayed localhost label resolves, not before', async () => {
    storeState.settings = { openLinksInApp: true, localhostWorktreeLabelsEnabled: true }
    storeState.repos = [{ id: 'repo-1', displayName: 'Repo' }]
    storeState.worktreesByRepo = { 'repo-1': [{ id: 'wt-1', projectId: 'repo-1' }] }
    storeState.workspacePortScansByKey = {
      'local:all': {
        platform: 'darwin',
        scannedAt: 1,
        ports: [
          {
            id: 'tcp:5180:wt-1',
            kind: 'workspace',
            port: 5180,
            protocol: 'http',
            bindHost: '127.0.0.1',
            connectHost: 'localhost',
            owner: {
              repoId: 'repo-1',
              worktreeId: 'wt-1',
              displayName: 'wt-1',
              path: '/wt-1',
              confidence: 'cwd'
            }
          }
        ]
      }
    }
    showBrowserBesideTerminal()
    let resolveLabel: (value: { url: string }) => void = () => {}
    registerLocalhostLabelMock.mockReturnValue(new Promise((resolve) => (resolveLabel = resolve)))

    openHttpLink('http://localhost:5180/', { worktreeId: 'wt-1', sourceOwner: { kind: 'local' } })
    expect(registerLocalhostLabelMock).toHaveBeenCalled()
    storeState.layoutByWorktree = { 'wt-1': { type: 'leaf', groupId: 'term' } }
    resolveLabel({ url: 'http://wt-1.orca.localhost:60016/' })

    await vi.waitFor(() => expect(createBrowserTabMock).toHaveBeenCalled())
    expect(createBrowserTabMock.mock.calls[0]![2]).toEqual({ activate: true })
    expect(focusGroupMock).not.toHaveBeenCalled()
  })

  it.each([
    [{ kind: 'ssh' as const, connectionId: 'ssh-1' }, { expectedSshConnectionId: 'ssh-1' }],
    [
      { kind: 'runtime' as const, runtimeEnvironmentId: 'env-1' },
      { expectedRuntimeEnvironmentId: 'env-1' }
    ]
  ])('asks the remote opener for the visible browser group (%o)', (sourceOwner, owner) => {
    storeState.settings = { openLinksInApp: true }
    showBrowserBesideTerminal()
    openHttpLink('https://example.com/', {
      worktreeId: 'wt-1',
      allowRemoteInApp: true,
      sourceOwner
    })
    expect(openRuntimeBrowserTabMock).toHaveBeenCalledWith({
      workspaceId: 'wt-1',
      url: 'https://example.com/',
      intent: { kind: 'url' },
      targetGroupId: 'web',
      ...owner
    })
    expect(focusGroupMock).toHaveBeenCalledWith('wt-1', 'web')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })
})
