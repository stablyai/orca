/**
 * Shared rig for the STA-4343 wrong-host removal tests.
 *
 * One REAL temp directory per execution host stands in for that host's checkout,
 * each holding a marker file for its uncommitted work. The removal transports are
 * the only fakes and they ACTUALLY delete the directory of whichever host they are
 * routed to, so the assertions gate on filesystem state rather than call
 * arguments — and the single-host controls delete for real through the same rig.
 *
 * Every assertion built on this names both sides: which host's directory had to
 * survive AND which had to go, so neither a rig that deletes nothing nor one that
 * deletes everything can pass.
 */
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

/**
 * Points both destructive transports at the per-host directories: `worktrees.remove`
 * carries local and SSH removals, `runtimeEnvironments.call` carries paired-runtime
 * ones. Every routed host id is appended to `routedHostIds`, so a test can assert
 * exactly which host the destructive call reached — or that none was dispatched.
 */
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
