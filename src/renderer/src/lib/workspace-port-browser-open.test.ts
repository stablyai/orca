// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspacePort } from '../../../shared/workspace-ports'

const {
  activateAndRevealWorktreeMock,
  assertRuntimeEnvironmentCapabilityMock,
  callRuntimeRpcMock
} = vi.hoisted(() => ({
  activateAndRevealWorktreeMock: vi.fn(),
  assertRuntimeEnvironmentCapabilityMock: vi.fn(),
  callRuntimeRpcMock: vi.fn()
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: activateAndRevealWorktreeMock
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  assertRuntimeEnvironmentCapability: assertRuntimeEnvironmentCapabilityMock,
  callRuntimeRpc: callRuntimeRpcMock
}))

const {
  getPortOpenBrowserTooltipLabel,
  getPortSystemBrowserHint,
  openWorkspacePortInBrowser,
  resolvePortOpenInOrcaBrowser
} = await import('./workspace-port-browser-open')

function workspacePort(overrides: Partial<WorkspacePort> = {}): WorkspacePort {
  return {
    id: 'tcp:5199',
    bindHost: '127.0.0.1',
    connectHost: '127.0.0.1',
    port: 5199,
    processName: 'node',
    protocol: 'http',
    kind: 'workspace',
    pid: 4242,
    owner: { worktreeId: 'wt-1' },
    ...overrides
  } as WorkspacePort
}

describe('resolvePortOpenInOrcaBrowser', () => {
  it('honors the saved setting when there is no click event', () => {
    expect(resolvePortOpenInOrcaBrowser({ settings: { openLinksInApp: true }, isMac: true })).toBe(
      true
    )
  })

  it('escapes to the system browser on Shift+Cmd click on Mac', () => {
    expect(
      resolvePortOpenInOrcaBrowser({
        settings: { openLinksInApp: true },
        event: { shiftKey: true, metaKey: true, ctrlKey: false },
        isMac: true
      })
    ).toBe(false)
  })

  it('does not escape on Shift+Ctrl click on Mac (wrong modifier for the platform)', () => {
    expect(
      resolvePortOpenInOrcaBrowser({
        settings: { openLinksInApp: true },
        event: { shiftKey: true, metaKey: false, ctrlKey: true },
        isMac: true
      })
    ).toBe(true)
  })

  it('escapes to the system browser on Shift+Ctrl click off Mac', () => {
    expect(
      resolvePortOpenInOrcaBrowser({
        settings: { openLinksInApp: true },
        event: { shiftKey: true, metaKey: false, ctrlKey: true },
        isMac: false
      })
    ).toBe(false)
  })

  it('does not escape on Shift alone with no platform modifier', () => {
    expect(
      resolvePortOpenInOrcaBrowser({
        settings: { openLinksInApp: true },
        event: { shiftKey: true, metaKey: false, ctrlKey: false },
        isMac: true
      })
    ).toBe(true)
  })
})

describe('getPortSystemBrowserHint / getPortOpenBrowserTooltipLabel', () => {
  it('reads the Mac shortcut on Mac', () => {
    expect(getPortSystemBrowserHint(true)).toBe('⇧⌘+click for system browser')
  })

  it('reads the Windows/Linux shortcut off Mac', () => {
    expect(getPortSystemBrowserHint(false)).toBe('Shift+Ctrl+click for system browser')
  })

  it('appends the hint to the open-label tooltip', () => {
    expect(getPortOpenBrowserTooltipLabel('Open in browser', true)).toBe(
      'Open in browser. ⇧⌘+click for system browser'
    )
  })
})

describe('openWorkspacePortInBrowser', () => {
  const localTarget = { kind: 'local' as const }
  const environmentTarget = { kind: 'environment' as const, environmentId: 'env-1' }

  function baseArgs(
    overrides: Partial<Parameters<typeof openWorkspacePortInBrowser>[0]> = {}
  ): Parameters<typeof openWorkspacePortInBrowser>[0] {
    return {
      port: workspacePort(),
      runtimeTarget: localTarget,
      createBrowserTab: vi.fn(),
      setRemoteBrowserPageHandle: vi.fn(),
      ...overrides
    }
  }

  beforeEach(() => {
    ;(globalThis.window as unknown as { api: Record<string, unknown> }).api = {
      ...(globalThis.window as unknown as { api?: Record<string, unknown> }).api,
      shell: { openUrl: vi.fn() },
      localhostWorktreeLabels: { register: vi.fn() }
    }
  })

  afterEach(() => {
    activateAndRevealWorktreeMock.mockReset()
    assertRuntimeEnvironmentCapabilityMock.mockReset()
    callRuntimeRpcMock.mockReset()
  })

  it('opens the system browser and skips worktree activation when openInOrcaBrowser is false', async () => {
    const openUrl = vi.fn().mockResolvedValue(undefined)
    window.api.shell.openUrl = openUrl
    const args = baseArgs({
      port: workspacePort({ kind: 'external' }),
      openInOrcaBrowser: false
    })

    const result = await openWorkspacePortInBrowser(args)

    expect(result).toEqual({ ok: true })
    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:5199')
    expect(activateAndRevealWorktreeMock).not.toHaveBeenCalled()
  })

  it('reports a failure reason when the system browser fails to open', async () => {
    window.api.shell.openUrl = vi.fn().mockRejectedValue(new Error('boom'))
    const args = baseArgs({
      port: workspacePort({ kind: 'external' }),
      openInOrcaBrowser: false
    })

    expect(await openWorkspacePortInBrowser(args)).toEqual({ ok: false, reason: 'boom' })
  })

  it('falls back to the generic reason when the system-browser error has no message', async () => {
    // Why: throwing a bare empty string (not `new Error('')`) exercises the same
    // falsy-message fallback in toFailureReason without an empty Error message.
    window.api.shell.openUrl = vi.fn().mockRejectedValue('')
    const args = baseArgs({
      port: workspacePort({ kind: 'external' }),
      openInOrcaBrowser: false
    })

    expect(await openWorkspacePortInBrowser(args)).toEqual({
      ok: false,
      reason: 'Failed to open system browser.'
    })
  })

  it('fails when there is no workspace to activate (external port, no active worktree)', async () => {
    const args = baseArgs({
      port: workspacePort({ kind: 'external' }),
      activeWorktreeId: null
    })

    expect(await openWorkspacePortInBrowser(args)).toEqual({
      ok: false,
      reason: 'No workspace selected for the browser.'
    })
    expect(activateAndRevealWorktreeMock).not.toHaveBeenCalled()
  })

  it('activates the owning worktree and opens a local Orca browser tab for a workspace port', async () => {
    const createBrowserTab = vi.fn().mockReturnValue({ activePageId: 'unused-for-local' })
    const args = baseArgs({ createBrowserTab })

    const result = await openWorkspacePortInBrowser(args)

    expect(activateAndRevealWorktreeMock).toHaveBeenCalledWith('wt-1', {
      providesInitialSurface: true
    })
    expect(createBrowserTab).toHaveBeenCalledWith('wt-1', 'http://127.0.0.1:5199', {
      activate: true
    })
    expect(result).toEqual({ ok: true })
  })

  it('reports a failure reason when creating the local browser tab throws', async () => {
    const createBrowserTab = vi.fn().mockImplementation(() => {
      throw new Error('tab failed')
    })
    const args = baseArgs({ createBrowserTab })

    expect(await openWorkspacePortInBrowser(args)).toEqual({ ok: false, reason: 'tab failed' })
  })

  it('falls back to the generic reason when the local-tab error has no message', async () => {
    // Regression net for the local-open fallback string specifically: a thrown
    // falsy value must not surface as reason: ''.
    const createBrowserTab = vi.fn().mockImplementation(() => {
      throw ''
    })
    const args = baseArgs({ createBrowserTab })

    expect(await openWorkspacePortInBrowser(args)).toEqual({
      ok: false,
      reason: 'Failed to open browser.'
    })
  })

  it('registers a localhost label and opens the returned url', async () => {
    window.api.localhostWorktreeLabels.register = vi
      .fn()
      .mockResolvedValue({ url: 'http://custom.local:5199' })
    const createBrowserTab = vi.fn().mockReturnValue({ activePageId: 'unused-for-local' })
    const args = baseArgs({
      createBrowserTab,
      localhostLabelRoute: {
        targetUrl: 'http://127.0.0.1:5199',
        projectName: 'orca',
        worktreeName: 'main'
      }
    })

    await openWorkspacePortInBrowser(args)

    expect(createBrowserTab).toHaveBeenCalledWith('wt-1', 'http://custom.local:5199', {
      activate: true
    })
  })

  it('falls back to the raw url when localhost label registration fails', async () => {
    window.api.localhostWorktreeLabels.register = vi.fn().mockRejectedValue(new Error('no label'))
    const createBrowserTab = vi.fn().mockReturnValue({ activePageId: 'unused-for-local' })
    const args = baseArgs({
      createBrowserTab,
      localhostLabelRoute: {
        targetUrl: 'http://127.0.0.1:5199',
        projectName: 'orca',
        worktreeName: 'main'
      }
    })

    await openWorkspacePortInBrowser(args)

    expect(createBrowserTab).toHaveBeenCalledWith('wt-1', 'http://127.0.0.1:5199', {
      activate: true
    })
  })

  it('opens a remote browser page through the environment runtime and records the page handle', async () => {
    assertRuntimeEnvironmentCapabilityMock.mockResolvedValue(undefined)
    callRuntimeRpcMock.mockResolvedValue({ browserPageId: 'remote-page-1' })
    const createBrowserTab = vi.fn().mockReturnValue({ activePageId: 'active-1' })
    const setRemoteBrowserPageHandle = vi.fn()
    const args = baseArgs({
      runtimeTarget: environmentTarget,
      createBrowserTab,
      setRemoteBrowserPageHandle
    })

    const result = await openWorkspacePortInBrowser(args)

    expect(callRuntimeRpcMock).toHaveBeenCalledWith(
      environmentTarget,
      'browser.tabCreate',
      { worktree: 'id:wt-1', url: 'http://127.0.0.1:5199' },
      { timeoutMs: 30_000 }
    )
    expect(setRemoteBrowserPageHandle).toHaveBeenCalledWith('active-1', {
      environmentId: 'env-1',
      remotePageId: 'remote-page-1'
    })
    expect(result).toEqual({ ok: true })
  })

  it('fails when the environment browser tab has no active page id', async () => {
    assertRuntimeEnvironmentCapabilityMock.mockResolvedValue(undefined)
    callRuntimeRpcMock.mockResolvedValue({ browserPageId: 'remote-page-1' })
    const createBrowserTab = vi.fn().mockReturnValue({ activePageId: undefined })
    const args = baseArgs({ runtimeTarget: environmentTarget, createBrowserTab })

    expect(await openWorkspacePortInBrowser(args)).toEqual({
      ok: false,
      reason: 'Failed to create a browser page.'
    })
  })

  it('reports a failure reason when the environment capability check rejects', async () => {
    assertRuntimeEnvironmentCapabilityMock.mockRejectedValue(new Error('capability denied'))
    const args = baseArgs({ runtimeTarget: environmentTarget })

    expect(await openWorkspacePortInBrowser(args)).toEqual({
      ok: false,
      reason: 'capability denied'
    })
    expect(callRuntimeRpcMock).not.toHaveBeenCalled()
  })

  it('reports a failure reason when the remote tabCreate RPC rejects', async () => {
    assertRuntimeEnvironmentCapabilityMock.mockResolvedValue(undefined)
    callRuntimeRpcMock.mockRejectedValue(new Error('rpc timed out'))
    const args = baseArgs({ runtimeTarget: environmentTarget })

    expect(await openWorkspacePortInBrowser(args)).toEqual({
      ok: false,
      reason: 'rpc timed out'
    })
  })
})
