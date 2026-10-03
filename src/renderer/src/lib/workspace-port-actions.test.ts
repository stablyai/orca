// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { WorkspacePort } from '../../../shared/workspace-ports'

const { activateAndRevealWorktreeMock, callRuntimeRpcMock, openUrlMock, registerLabelMock } =
  vi.hoisted(() => ({
    activateAndRevealWorktreeMock: vi.fn(),
    callRuntimeRpcMock: vi.fn(),
    openUrlMock: vi.fn(),
    registerLabelMock: vi.fn()
  }))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: activateAndRevealWorktreeMock
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  assertRuntimeEnvironmentCapability: vi.fn().mockResolvedValue(undefined),
  callRuntimeRpc: callRuntimeRpcMock,
  RuntimeRpcCallError: class RuntimeRpcCallError extends Error {
    code?: string
  }
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(() => undefined, { getState: () => ({}) })
}))

import {
  mergeWorkspacePortScans,
  openWorkspacePortInBrowser,
  runtimeTargetForWorkspacePortScanKey,
  workspacePortScanKeyForTarget
} from './workspace-port-actions'

const PORT: WorkspacePort = {
  kind: 'workspace',
  id: '0.0.0.0:5173:1',
  bindHost: '0.0.0.0',
  connectHost: 'localhost',
  port: 5173,
  protocol: 'http',
  owner: {
    worktreeId: 'repo-1:feature',
    repoId: 'repo-1',
    displayName: 'feature',
    path: '/srv/work/feature',
    confidence: 'cwd'
  }
}

const REACHABLE_URL = 'http://100.64.1.20:5173'

type OpenArgs = Parameters<typeof openWorkspacePortInBrowser>[0]

function browserWorkspace(worktreeId: string, url: string): BrowserWorkspace {
  return {
    id: 'tab-1',
    worktreeId,
    activePageId: 'page-1',
    url,
    title: url,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 0
  }
}

const createBrowserTab = vi.fn<OpenArgs['createBrowserTab']>((worktreeId, url) =>
  browserWorkspace(worktreeId, url)
)
const setRemoteBrowserPageHandle = vi.fn<OpenArgs['setRemoteBrowserPageHandle']>()

function openArgs(overrides: Partial<OpenArgs> = {}): OpenArgs {
  return {
    port: PORT,
    runtimeTarget: { kind: 'environment', environmentId: 'env-1' },
    createBrowserTab,
    setRemoteBrowserPageHandle,
    ...overrides
  }
}

describe('openWorkspacePortInBrowser system-browser routing', () => {
  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = {
      shell: { openUrl: openUrlMock },
      localhostWorktreeLabels: { register: registerLabelMock }
    }
    openUrlMock.mockReset().mockResolvedValue(undefined)
    callRuntimeRpcMock.mockReset().mockResolvedValue({ browserPageId: 'remote-1' })
    createBrowserTab.mockClear()
    setRemoteBrowserPageHandle.mockClear()
    activateAndRevealWorktreeMock.mockClear()
    registerLabelMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens a local port in the system browser on the stock plain click, as before', async () => {
    await expect(
      openWorkspacePortInBrowser(
        openArgs({ runtimeTarget: { kind: 'local' }, openInOrcaBrowser: false })
      )
    ).resolves.toEqual({ ok: true })
    expect(openUrlMock).toHaveBeenCalledWith('http://localhost:5173')
  })

  it('opens the registered worktree-label URL for a local port when one is routed', async () => {
    registerLabelMock.mockResolvedValue({ url: 'http://feature.localhost:5173' })
    await openWorkspacePortInBrowser(
      openArgs({
        runtimeTarget: { kind: 'local' },
        openInOrcaBrowser: false,
        localhostLabelRoute: {
          targetUrl: 'http://localhost:5173',
          projectName: 'orca',
          worktreeName: 'feature',
          worktreeId: 'repo-1:feature'
        }
      })
    )
    expect(openUrlMock).toHaveBeenCalledWith('http://feature.localhost:5173')
  })

  it('keeps a remote port in the embedded browser on a stock plain click', async () => {
    // Regression: openLinksInApp defaults to false, so `openInOrcaBrowser === false` is
    // every ordinary click. Routing on that alone sent every remote wildcard-bound port
    // out to a URL that may be firewalled, with no fallback and no error.
    await expect(
      openWorkspacePortInBrowser(
        openArgs({ openInOrcaBrowser: false, clientReachableUrl: REACHABLE_URL })
      )
    ).resolves.toEqual({ ok: true })
    expect(openUrlMock).not.toHaveBeenCalled()
    expect(callRuntimeRpcMock).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'browser.tabCreate',
      expect.objectContaining({ url: 'http://localhost:5173' }),
      expect.anything()
    )
  })

  it('opens the reachable URL for a remote port only when the modifier asked for it', async () => {
    await expect(
      openWorkspacePortInBrowser(
        openArgs({
          openInOrcaBrowser: false,
          systemBrowserRequested: true,
          clientReachableUrl: REACHABLE_URL
        })
      )
    ).resolves.toEqual({ ok: true })
    expect(openUrlMock).toHaveBeenCalledWith(REACHABLE_URL)
    expect(callRuntimeRpcMock).not.toHaveBeenCalled()
  })

  it('falls back to the embedded browser when the modifier has no reachable URL', async () => {
    await expect(
      openWorkspacePortInBrowser(
        openArgs({
          openInOrcaBrowser: false,
          systemBrowserRequested: true,
          clientReachableUrl: null
        })
      )
    ).resolves.toEqual({ ok: true })
    expect(openUrlMock).not.toHaveBeenCalled()
    expect(callRuntimeRpcMock).toHaveBeenCalled()
  })
})

describe('runtimeTargetForWorkspacePortScanKey', () => {
  it('round-trips every target a scan key can name', () => {
    for (const target of [
      { kind: 'local' },
      { kind: 'environment', environmentId: 'env-1' },
      { kind: 'environment', environmentId: 'env:with:colons' }
    ] as const) {
      expect(runtimeTargetForWorkspacePortScanKey(workspacePortScanKeyForTarget(target))).toEqual(
        target
      )
    }
  })

  it('refuses the synthetic all-hosts key and anything that names no single host', () => {
    expect(runtimeTargetForWorkspacePortScanKey('all-hosts:all')).toBeNull()
    expect(runtimeTargetForWorkspacePortScanKey('environment::all')).toBeNull()
    expect(runtimeTargetForWorkspacePortScanKey('local')).toBeNull()
    expect(runtimeTargetForWorkspacePortScanKey(undefined)).toBeNull()
  })
})

describe('mergeWorkspacePortScans', () => {
  it('stamps the owning host on a single-host projection too', () => {
    // Regression: the one-entry fast path returned the scan untouched, so every row in the
    // status bar's projection fell back to the active workspace's host — the exact
    // misattribution the scan key exists to prevent, just with one host scanned.
    const merged = mergeWorkspacePortScans({
      'environment:env-1:all': { platform: 'darwin', scannedAt: 10, ports: [PORT] }
    })
    expect(merged?.ports.map((port) => port.hostScanKey)).toEqual(['environment:env-1:all'])
    // The id prefix stays off: one host's ids are already unique, and prefixing would
    // churn every React row key the moment a second host appears or disappears.
    expect(merged?.ports.map((port) => port.id)).toEqual([PORT.id])
  })
})
