// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { WorkspacePort } from '../../../../../shared/workspace/ports/workspace-ports'
import type { useAppStore as UseAppStore } from '@/store'
import type { useBrowserNewTabServers as UseBrowserNewTabServers } from './use-browser-new-tab-servers'

const probeWorkspacePortPageForTarget = vi.hoisted(() => vi.fn())
vi.mock('@/lib/workspace-ports/workspace-port-scan-client', () => ({
  probeWorkspacePortPageForTarget
}))
vi.mock('@/lib/workspace-ports/workspace-port-scan-refresh', () => ({
  refreshWorkspacePortScanForTarget: vi.fn()
}))

const worktreeId = 'repo-1::/repo'
let useAppStore: typeof UseAppStore
let useBrowserNewTabServers: typeof UseBrowserNewTabServers

beforeEach(async () => {
  // The probe cache and the store live at module scope; each test starts with fresh ones.
  vi.resetModules()
  ;({ useAppStore } = await import('@/store'))
  ;({ useBrowserNewTabServers } = await import('./use-browser-new-tab-servers'))
  probeWorkspacePortPageForTarget.mockReset()
  probeWorkspacePortPageForTarget.mockResolvedValue({
    kind: 'page',
    title: 'App',
    faviconDataUrl: null
  })
})

function workspacePort(port: number, processName: string, bindHost: string): WorkspacePort {
  return {
    id: `${bindHost}:${port}`,
    bindHost,
    connectHost: bindHost === '0.0.0.0' ? 'localhost' : bindHost,
    port,
    processName,
    protocol: 'unknown',
    kind: 'workspace',
    owner: { worktreeId, repoId: 'repo-1', displayName: 'main', path: '/repo', confidence: 'cwd' }
  }
}

async function renderServerPorts(ports: WorkspacePort[]): Promise<number[]> {
  useAppStore.setState({
    workspacePortScansByKey: { 'local:all': { platform: 'linux', scannedAt: 1, ports } }
  })
  const { result } = renderHook(() => useBrowserNewTabServers(worktreeId, { kind: 'local' }))
  await waitFor(() => expect(result.current.own).not.toHaveLength(0))
  return result.current.own.map((server) => server.port.port)
}

function probedPorts(): number[] {
  return probeWorkspacePortPageForTarget.mock.calls.map(([, request]) => request.port)
}

it('does not probe the Android emulator modem listener on [::1]', async () => {
  const servers = await renderServerPorts([
    workspacePort(3000, 'node', '0.0.0.0'),
    workspacePort(52811, 'qemu-system-aarch64', '::1'),
    // Linux /proc/<pid>/comm truncates the name to 15 chars.
    workspacePort(52812, 'qemu-system-aar', '::1')
  ])

  expect(servers).toEqual([3000])
  expect(probedPorts()).toEqual([3000])
})

it('still probes qemu hostfwd listeners bound to IPv4', async () => {
  await renderServerPorts([
    workspacePort(8080, 'qemu-system-x86_64', '0.0.0.0'),
    workspacePort(8081, 'qemu-system-x86_64', '127.0.0.1')
  ])

  expect(probedPorts()).toEqual([8080, 8081])
})

it('still probes a node server on [::1]', async () => {
  const servers = await renderServerPorts([workspacePort(5173, 'node', '::1')])

  expect(servers).toEqual([5173])
  expect(probedPorts()).toEqual([5173])
})
