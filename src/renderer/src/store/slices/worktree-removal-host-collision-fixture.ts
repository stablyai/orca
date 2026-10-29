/** One real temp checkout per host; transport fakes delete whichever host they receive. Assert both survivor and deletion, including single-host controls, to reject inert or indiscriminate rigs (STA-4343). */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export const COLLIDING_WORKTREE_ID = 'repo1::/shared/workspace/path'
export const COLLIDING_WORKTREE_PATH = '/shared/workspace/path'
export const LOCAL_HOST: ExecutionHostId = 'local'
export const SSH_HOST: ExecutionHostId = 'ssh:ssh-1'
export const RELAY_HOST: ExecutionHostId = 'runtime:env-1'

export const HOST_COLLISION_MESSAGE =
  'Error: this workspace exists on multiple hosts at the same path'
export const HOST_UNRESOLVED_MESSAGE =
  'Orca cannot tell which host owns this workspace. Refresh projects and review it again.'

export type HostCheckout = { root: string; markerPath: string }

const hostDirCleanup: (() => void)[] = []

/** One real directory per host; its marker file is that host's uncommitted work. */
export function createHostCheckout(hostId: ExecutionHostId): HostCheckout {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sta4343-'))
  hostDirCleanup.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const markerPath = path.join(root, 'UNCOMMITTED_WORK')
  fs.writeFileSync(markerPath, `uncommitted work on ${hostId}`)
  return { root, markerPath }
}

export function cleanupHostCheckouts(): void {
  for (const cleanup of hostDirCleanup.splice(0)) {
    cleanup()
  }
}

export type RemovalTransportMocks = {
  remove: { mockImplementation: (impl: (args: { hostId?: string }) => unknown) => unknown }
  runtimeCall: {
    mockImplementation: (
      impl: (args: { method: string; params?: { hostId?: string } }) => unknown
    ) => unknown
  }
}

/** Wire local/SSH worktrees.remove and paired runtimeEnvironments.call to host directories; record every destructive host in routedHostIds. */
export function installRemovalTransports(
  transports: RemovalTransportMocks,
  rootsByHostId: Partial<Record<ExecutionHostId, string>>,
  routedHostIds: string[]
): void {
  const deleteOnHost = (hostId: string | undefined): void => {
    routedHostIds.push(hostId ?? '<missing>')
    const root = hostId ? rootsByHostId[hostId as ExecutionHostId] : undefined
    if (root) {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
  transports.remove.mockImplementation(async (args: { hostId?: string }) => {
    deleteOnHost(args.hostId)
    return {}
  })
  transports.runtimeCall.mockImplementation(
    (args: { method: string; params?: { hostId?: string } }) => {
      // Only the removal RPC is destructive; capability probes share this transport.
      if (args.method === 'worktree.rm') {
        deleteOnHost(args.params?.hostId)
      }
      return { id: 'rpc-rm', ok: true, result: {}, _meta: { runtimeId: 'runtime-remote' } }
    }
  )
}
