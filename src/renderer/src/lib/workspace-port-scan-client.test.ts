import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspacePort } from '../../../shared/workspace-ports'

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  RuntimeRpcCallError: class RuntimeRpcCallError extends Error {
    code = 'unknown'
  }
}))

const scan = vi.fn()
vi.stubGlobal('window', { api: { workspacePorts: { scan } } })

const { runWorkspacePortScanForTarget } = await import('./workspace-port-scan-client')

const localTarget = { kind: 'local' } as Parameters<typeof runWorkspacePortScanForTarget>[0]

const workspacePort: WorkspacePort = {
  id: '127.0.0.1:5173:123',
  bindHost: '127.0.0.1',
  connectHost: 'localhost',
  port: 5173,
  pid: 123,
  processName: 'node',
  protocol: 'http',
  kind: 'workspace',
  owner: {
    worktreeId: 'repo::/repo',
    repoId: 'repo',
    displayName: 'main',
    path: '/repo',
    confidence: 'cwd'
  }
}

function scanResultWith(port: unknown): unknown {
  return { platform: 'darwin', scannedAt: 1_700_000_000_000, ports: [port] }
}

describe('workspace port scan response validation', () => {
  beforeEach(() => {
    scan.mockReset()
  })

  it('accepts a port carrying a dev server identity', async () => {
    scan.mockResolvedValue(
      scanResultWith({ ...workspacePort, devServer: { id: 'vite', label: 'Vite' } })
    )

    const result = await runWorkspacePortScanForTarget(localTarget)

    expect(result.ports[0]?.devServer).toEqual({ id: 'vite', label: 'Vite' })
  })

  it('accepts a port with no dev server identity', async () => {
    scan.mockResolvedValue(scanResultWith(workspacePort))

    const result = await runWorkspacePortScanForTarget(localTarget)

    expect(result.ports[0]?.devServer).toBeUndefined()
  })

  it.each([
    ['a non-string label', { id: 'vite', label: { toString: 'Vite' } }],
    ['a missing label', { id: 'vite' }],
    ['a missing id', { label: 'Vite' }],
    ['a non-object identity', 'Vite']
  ])('rejects a scan whose dev server identity has %s', async (_case, devServer) => {
    // Why this matters: a remote runtime supplies this payload and the label is
    // rendered straight into a row, so a bad shape must fail here, not in React.
    scan.mockResolvedValue(scanResultWith({ ...workspacePort, devServer }))

    await expect(runWorkspacePortScanForTarget(localTarget)).rejects.toThrow(
      'Workspace port scan returned an invalid response.'
    )
  })
})
