// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspacePort, WorkspacePortScanResult } from '../../../../shared/workspace-ports'

const { popoverHandle, runWorkspacePortScanForTargetMock, storeState } = vi.hoisted(() => {
  const storeState = {
    settings: { activeRuntimeEnvironmentId: null as string | null },
    activeWorktreeId: 'runtime-repo::/srv/app',
    workspacePortScan: null as { key: string; result: WorkspacePortScanResult } | null,
    workspacePortScansByKey: {} as Record<string, WorkspacePortScanResult>,
    workspacePortScanRefreshing: false,
    runtimeEnvironments: [] as { id: string; name: string }[],
    recordFeatureInteraction: vi.fn(),
    replaceWorkspacePortScans:
      vi.fn<
        (
          scansByKey: Record<string, WorkspacePortScanResult>,
          projection: { key: string; result: WorkspacePortScanResult } | null
        ) => void
      >()
  }
  // Why: the real store writes back. A bare spy lets a publish and the notice
  // that reads it drift onto different scan keys with every assertion green.
  storeState.replaceWorkspacePortScans.mockImplementation((scansByKey, projection) => {
    storeState.workspacePortScansByKey = scansByKey
    storeState.workspacePortScan = projection
  })
  return {
    popoverHandle: { onOpenChange: null as ((open: boolean) => void) | null },
    runWorkspacePortScanForTargetMock: vi.fn(),
    storeState
  }
})

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState }
  )
  return { useAppStore }
})

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: (_state: unknown, worktreeId: string | null | undefined) => {
    if (worktreeId === 'runtime-repo::/srv/app') {
      return 'runtime:env-1'
    }
    if (worktreeId === 'ssh-repo::/srv/app') {
      return 'ssh:server-1'
    }
    return 'local'
  }
}))

vi.mock('@/runtime/runtime-rpc-client', async () => {
  const actual = await import('@/runtime/runtime-client-target')
  return {
    getActiveRuntimeTarget: actual.getActiveRuntimeTarget,
    callRuntimeRpc: vi.fn(),
    assertRuntimeEnvironmentCapability: vi.fn(),
    RuntimeRpcCallError: class RuntimeRpcCallError extends Error {
      code?: string
    }
  }
})

vi.mock('@/lib/workspace-port-scan-client', () => ({
  runWorkspacePortScanForTarget: runWorkspacePortScanForTargetMock
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({
    children,
    onOpenChange
  }: {
    children: React.ReactNode
    onOpenChange: (open: boolean) => void
  }) => {
    popoverHandle.onOpenChange = onOpenChange
    return <>{children}</>
  },
  PopoverContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/SelectedTextCopyMenu', () => ({
  SelectedTextCopyMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('./ports-status-popover-rows', () => ({
  PortRow: () => <div data-testid="port-row" />,
  WorkspaceGroupRows: () => <div data-testid="workspace-group-rows" />
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    options
      ? fallback.replace(/{{(\w+)}}/g, (_match, name: string) => String(options[name] ?? ''))
      : fallback
}))

import { PortsStatusSegment } from './PortsStatusSegment'

function workspacePort(overrides: Partial<WorkspacePort> & { port: number; id: string }) {
  return {
    bindHost: '0.0.0.0',
    connectHost: '127.0.0.1',
    port: overrides.port,
    id: overrides.id,
    pid: 4321,
    processName: 'node',
    protocol: 'http' as const,
    kind: 'workspace' as const,
    owner: {
      worktreeId: 'runtime-repo::/srv/app',
      repoId: 'runtime-repo',
      displayName: 'runtime app',
      path: '/srv/app',
      confidence: 'cwd' as const
    }
  }
}

const localHostScan: WorkspacePortScanResult = {
  platform: 'linux',
  scannedAt: 10,
  ports: [workspacePort({ id: 'local-5173', port: 5173 })]
}

const remoteHostScan: WorkspacePortScanResult = {
  platform: 'linux',
  scannedAt: 20,
  ports: [workspacePort({ id: 'remote-3000', port: 3000 })]
}

describe('PortsStatusSegment popover host routing', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    popoverHandle.onOpenChange = null
    storeState.settings = { activeRuntimeEnvironmentId: null }
    storeState.activeWorktreeId = 'runtime-repo::/srv/app'
    storeState.workspacePortScan = null
    storeState.workspacePortScansByKey = { 'local:all': localHostScan }
    storeState.runtimeEnvironments = [{ id: 'env-1', name: 'linux-box' }]
    storeState.recordFeatureInteraction.mockClear()
    storeState.replaceWorkspacePortScans.mockClear()
    runWorkspacePortScanForTargetMock.mockReset()
    runWorkspacePortScanForTargetMock.mockResolvedValue(remoteHostScan)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(<PortsStatusSegment iconOnly={false} />)
    })
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  async function openPopover(): Promise<void> {
    await act(async () => {
      popoverHandle.onOpenChange?.(true)
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it("scans the active workspace's host, not the globally focused runtime", async () => {
    await openPopover()

    expect(runWorkspacePortScanForTargetMock).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      undefined
    )
    expect(storeState.replaceWorkspacePortScans).toHaveBeenCalledTimes(1)
    expect(storeState.workspacePortScansByKey['environment:env-1:all']).toBe(remoteHostScan)
  })

  it('keeps other hosts in the projection instead of overwriting it with one host', async () => {
    await openPopover()

    const [, projection] = storeState.replaceWorkspacePortScans.mock.calls.at(-1) as [
      Record<string, WorkspacePortScanResult>,
      { key: string; result: WorkspacePortScanResult }
    ]
    expect(projection).toEqual({
      key: 'all-hosts:all',
      result: expect.objectContaining({
        ports: expect.arrayContaining([
          expect.objectContaining({ port: 5173 }),
          expect.objectContaining({ port: 3000 })
        ])
      })
    })
  })

  it('publishes a failed scan under its own host without dropping other hosts', async () => {
    runWorkspacePortScanForTargetMock.mockRejectedValueOnce(new Error('remote scan failed'))

    await openPopover()

    const [, projection] = storeState.replaceWorkspacePortScans.mock.calls.at(-1) as [
      Record<string, WorkspacePortScanResult>,
      { key: string; result: WorkspacePortScanResult }
    ]
    expect(projection.key).toBe('all-hosts:all')
    expect(projection.result.ports).toEqual([expect.objectContaining({ port: 5173 })])
    expect(storeState.workspacePortScansByKey['environment:env-1:all']).toEqual(
      expect.objectContaining({ unavailableReason: 'remote scan failed' })
    )
  })

  it('keeps the failed host last-good ports while naming the failure', async () => {
    storeState.workspacePortScansByKey = {
      'local:all': localHostScan,
      'environment:env-1:all': remoteHostScan
    }
    runWorkspacePortScanForTargetMock.mockRejectedValueOnce(new Error('remote scan failed'))

    await openPopover()

    // Why: one dropped scan must not clear the host's ports the way the
    // background poll's debounce does not — the notice names the failure
    // while the projection keeps serving the last-good rows.
    const failed = storeState.workspacePortScansByKey['environment:env-1:all']
    expect(failed.unavailableReason).toBe('remote scan failed')
    expect(failed.platform).toBe('linux')
    expect(failed.ports).toEqual([expect.objectContaining({ port: 3000 })])
    const [, projection] = storeState.replaceWorkspacePortScans.mock.calls.at(-1) as [
      Record<string, WorkspacePortScanResult>,
      { key: string; result: WorkspacePortScanResult }
    ]
    expect(projection.key).toBe('all-hosts:all')
    expect(projection.result.ports.map((port) => port.port).sort()).toEqual([3000, 5173])
  })

  // Why: separate tests already cover "the failure is stored" and "a stored
  // failure renders". Only this one proves both halves name the same scan key.
  it('surfaces the host it just failed to scan on the next render', async () => {
    runWorkspacePortScanForTargetMock.mockRejectedValueOnce(new Error('remote scan failed'))

    await openPopover()
    act(() => {
      root.render(<PortsStatusSegment iconOnly={false} />)
    })

    expect(container.textContent).toContain(
      'Port scan unavailable on linux-box: remote scan failed'
    )
  })

  it('names the host whose scan failed while another host still reports ports', () => {
    act(() => {
      root.unmount()
    })
    storeState.workspacePortScansByKey = {
      'local:all': localHostScan,
      'environment:env-1:all': {
        platform: 'linux',
        scannedAt: 30,
        ports: [],
        unavailableReason: 'Remote connection dropped'
      }
    }
    storeState.workspacePortScan = { key: 'all-hosts:all', result: localHostScan }
    root = createRoot(container)
    act(() => {
      root.render(<PortsStatusSegment iconOnly={false} />)
    })

    expect(container.textContent).toContain(
      'Port scan unavailable on linux-box: Remote connection dropped'
    )
    // The notice sits above the list rather than replacing it: a reachable
    // host's count still renders.
    expect(container.textContent).toContain('1 workspace')
  })

  // Why: a failed scan keeps the host's last-good ports, and the badge and
  // header count them. Replacing the list with the notice left the popover
  // claiming N ports over an empty body.
  it('keeps the list under the notice when a failed scan retained its ports', () => {
    act(() => {
      root.unmount()
    })
    storeState.activeWorktreeId = 'local-repo::/home/dev/app'
    const retained: WorkspacePortScanResult = {
      ...localHostScan,
      unavailableReason: 'lsof is unavailable'
    }
    storeState.workspacePortScansByKey = { 'local:all': retained }
    storeState.workspacePortScan = { key: 'local:all', result: retained }
    root = createRoot(container)
    act(() => {
      root.render(<PortsStatusSegment iconOnly={false} />)
    })

    expect(container.textContent).toContain('1 workspace · 0 external')
    expect(container.querySelectorAll('[data-testid="workspace-group-rows"]')).toHaveLength(1)
    expect(container.textContent).toContain('Port scan unavailable on Local Linux')
  })

  // Why: total loss of contact is where naming the host matters most, and the
  // merged projection can only offer platform 'unknown' and raw scan keys.
  it('names every host when all of them failed with nothing left to list', () => {
    act(() => {
      root.unmount()
    })
    const merged: WorkspacePortScanResult = {
      platform: 'unknown',
      scannedAt: 30,
      ports: [],
      unavailableReason: 'local:all: lsof is unavailable; environment:env-1:all: dropped'
    }
    storeState.workspacePortScansByKey = {
      'local:all': {
        platform: 'darwin',
        scannedAt: 30,
        ports: [],
        unavailableReason: 'lsof is unavailable'
      },
      'environment:env-1:all': {
        platform: 'linux',
        scannedAt: 30,
        ports: [],
        unavailableReason: 'dropped'
      }
    }
    storeState.workspacePortScan = { key: 'all-hosts:all', result: merged }
    root = createRoot(container)
    act(() => {
      root.render(<PortsStatusSegment iconOnly={false} />)
    })

    // Local label comes from the scan's own platform, not the renderer's
    // userAgent — a paired web client is not the Orca host.
    expect(container.textContent).toContain(
      'Port scan unavailable on Local Mac: lsof is unavailable'
    )
    expect(container.textContent).toContain('Port scan unavailable on linux-box: dropped')
    expect(container.textContent).not.toContain('unavailable on unknown')
    expect(container.textContent).not.toContain('environment:env-1:all:')
    // The notice takes over the body only when there is nothing left to list.
    expect(container.querySelectorAll('[data-testid="workspace-group-rows"]')).toHaveLength(0)
    expect(container.textContent).not.toContain('No workspace ports detected')
  })

  it('stays on the local host when the active workspace has no runtime owner', async () => {
    act(() => {
      root.unmount()
    })
    storeState.activeWorktreeId = 'local-repo::/home/dev/app'
    root = createRoot(container)
    act(() => {
      root.render(<PortsStatusSegment iconOnly={false} />)
    })

    await openPopover()

    expect(runWorkspacePortScanForTargetMock).toHaveBeenCalledWith({ kind: 'local' }, undefined)
    const [nextScans, projection] = storeState.replaceWorkspacePortScans.mock.calls.at(-1) as [
      Record<string, WorkspacePortScanResult>,
      { key: string; result: WorkspacePortScanResult }
    ]
    expect(nextScans['local:all']).toBe(remoteHostScan)
    expect(projection).toEqual({
      key: 'local:all',
      result: remoteHostScan
    })
  })

  it('does not substitute the local host for a direct-SSH workspace', async () => {
    act(() => {
      root.unmount()
    })
    storeState.activeWorktreeId = 'ssh-repo::/srv/app'
    root = createRoot(container)
    act(() => {
      root.render(<PortsStatusSegment iconOnly={false} />)
    })

    await openPopover()

    expect(runWorkspacePortScanForTargetMock).not.toHaveBeenCalled()
    expect(storeState.replaceWorkspacePortScans).not.toHaveBeenCalled()
    expect(storeState.recordFeatureInteraction).toHaveBeenCalledWith('ports')
  })
})
