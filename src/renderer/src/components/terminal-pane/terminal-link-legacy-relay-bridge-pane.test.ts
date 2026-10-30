import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ILink } from '@xterm/xterm'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import {
  installTerminalLinkTestEnvironment,
  setPlatform
} from './terminal-link-handlers-test-harness'
import { createProviderSetup, makeBufferLine } from './terminal-link-provider-buffer-fixtures'
import { resolveTerminalLinkRuntimeEnvironmentId } from './terminal-http-link-source-owner'

const doubles = createTerminalLinkTestDoubles()
const { storeState, runtimeEnvironmentCallMock } = doubles
const bridged = vi.hoisted(() => ({ ptyIds: new Set<string>() }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: vi.fn(() => null) }))
vi.mock('./legacy-relay-bridge-panes', () => ({
  legacyRelayBridgedPane: (ptyId: string) =>
    bridged.ptyIds.has(ptyId) ? { ptyId, targetId: 'box', tabId: 't', state: 'live' } : undefined
}))
installTerminalLinkTestEnvironment(doubles)

const WORKTREE_ID = 'repo-1::/home/u/proj'
// What the bridge transport reports while an older Orca's relay still runs the pane.
const relayPtyId = toAppSshPtyId('box', 'pty2:0360053e-409a-415b-8dee-dd911e8330ba:3')
const bridgedTransport = {
  getPtyId: () => relayPtyId,
  getRuntimeEnvironmentId: () => null,
  getConnectionId: () => null
}

// The workspace after its SSH host moved to a managed server.
const movedRows: WorktreeOperationRouteState = {
  repos: [{ id: 'repo-1', executionHostId: 'runtime:env-1' }],
  worktreesByRepo: {
    'repo-1': [
      {
        id: WORKTREE_ID,
        repoId: 'repo-1',
        hostId: 'runtime:env-1',
        runtimeOwnerEnvironmentId: 'env-1'
      }
    ]
  }
}
// The same workspace while this desktop still dials the SSH host directly.
const directSshRows: WorktreeOperationRouteState = {
  repos: [{ id: 'repo-1', executionHostId: 'ssh:box', connectionId: 'box' }],
  worktreesByRepo: { 'repo-1': [{ id: WORKTREE_ID, repoId: 'repo-1', hostId: 'ssh:box' }] }
}

function hover(runtimeEnvironmentId: string | null): Promise<ILink[]> {
  const { provider } = createProviderSetup(
    [makeBufferLine('⏺ Update(src/app/page.tsx)')],
    new Map(),
    {
      worktreeId: WORKTREE_ID,
      worktreePath: '/home/u/proj',
      startupCwd: '/home/u/proj',
      getRuntimeEnvironmentIdForPane: () => runtimeEnvironmentId
    }
  )
  return new Promise((resolve) => provider.provideLinks(1, (links) => resolve(links ?? [])))
}

describe('file links in a relay-era pane the legacy relay bridge serves', () => {
  beforeEach(() => {
    setPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    bridged.ptyIds = new Set([relayPtyId])
    storeState.worktreesByRepo = {
      'repo-1': [
        { id: WORKTREE_ID, path: '/home/u/proj', repoId: 'repo-1', hostId: 'runtime:env-1' }
      ]
    }
  })

  it("checks printed paths on the workspace's managed server, not this computer", async () => {
    runtimeEnvironmentCallMock.mockImplementation(
      async (args: { method: string; params: { relativePaths: string[] } }) => ({
        id: 'rpc',
        ok: true,
        result: args.params.relativePaths.map(() => ({ exists: true })),
        _meta: { runtimeId: 'remote-runtime' }
      })
    )

    const runtimeEnvironmentId = resolveTerminalLinkRuntimeEnvironmentId(
      bridgedTransport,
      movedRows,
      WORKTREE_ID
    )
    const links = await hover(runtimeEnvironmentId)

    expect(runtimeEnvironmentId).toBe('env-1')
    expect(links.map((link) => link.text)).toEqual(['src/app/page.tsx'])
    expect(window.api.shell.pathExists).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'files.pathsExist',
        params: { worktree: `id:${WORKTREE_ID}`, relativePaths: ['src/app/page.tsx'] }
      })
    )
  })

  it('keeps a workspace this desktop still dials over SSH off any server', () => {
    expect(
      resolveTerminalLinkRuntimeEnvironmentId(bridgedTransport, directSshRows, WORKTREE_ID)
    ).toBeNull()
  })

  it('leaves an SSH pane the bridge does not serve as it was', () => {
    bridged.ptyIds = new Set()
    expect(
      resolveTerminalLinkRuntimeEnvironmentId(bridgedTransport, movedRows, WORKTREE_ID)
    ).toBeNull()
  })

  it("prefers a pane's own server", () => {
    expect(
      resolveTerminalLinkRuntimeEnvironmentId(
        { ...bridgedTransport, getRuntimeEnvironmentId: () => 'env-2' },
        movedRows,
        WORKTREE_ID
      )
    ).toBe('env-2')
  })
})
