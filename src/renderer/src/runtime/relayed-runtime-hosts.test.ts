import { describe, expect, it } from 'vitest'
import { RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY } from '../../../shared/mobile-desktop-relay-contract'
import { runtimeEnvironmentStatusFromSnapshot } from '../../../shared/runtime-host-status'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import {
  MAX_RELAYED_HOSTS,
  MAX_RELAYED_ROWS_PER_HOST,
  MAX_RELAYED_TEXT_LENGTH,
  parseRelayedHosts,
  parseRelayedWorkspaceRows,
  relayingRuntimeOwners
} from './relayed-runtime-hosts'

const host = (hostId: string, extra: Record<string, unknown> = {}) => ({
  hostId,
  label: hostId,
  health: 'available',
  relay: 'ready',
  ...extra
})

describe('parseRelayedHosts', () => {
  it('keeps only relayable runtime servers, once each, capped', () => {
    const hosts = [
      host('runtime:vm-1', { label: 'x'.repeat(MAX_RELAYED_TEXT_LENGTH + 50) }),
      host('runtime:vm-1', { label: 'duplicate' }),
      host('runtime:old', { relay: 'update-needed' }),
      host('runtime:gone', { relay: 'unavailable' }),
      host('ssh:box'),
      { hostId: 'runtime:no-label', relay: 'ready' },
      ...Array.from({ length: MAX_RELAYED_HOSTS + 10 }, (_, index) =>
        host(`runtime:vm-${index + 2}`)
      )
    ]
    const parsed = parseRelayedHosts({ hosts })

    expect(parsed).toHaveLength(MAX_RELAYED_HOSTS)
    expect(parsed?.[0]).toEqual({
      hostId: 'runtime:vm-1',
      label: 'x'.repeat(MAX_RELAYED_TEXT_LENGTH)
    })
    expect(new Set(parsed?.map((entry) => entry.hostId)).size).toBe(MAX_RELAYED_HOSTS)
    expect(parsed?.some((entry) => !entry.hostId.startsWith('runtime:vm-'))).toBe(false)
  })

  it('treats a malformed answer as unreadable', () => {
    expect(parseRelayedHosts({ hosts: 'nope' })).toBeNull()
    expect(parseRelayedHosts(null)).toBeNull()
  })
})

describe('parseRelayedWorkspaceRows', () => {
  it('keeps unarchived rows once each, with clipped text, capped', () => {
    const rows = [
      { worktreeId: 'w-1', branch: 'b'.repeat(MAX_RELAYED_TEXT_LENGTH + 1), repo: 'orca' },
      { worktreeId: 'w-1', displayName: 'duplicate' },
      { worktreeId: 'w-archived', isArchived: true },
      { worktreeId: '' },
      { worktreeId: 'w-folder', workspaceKind: 'folder-workspace', displayName: 'Notes' },
      ...Array.from({ length: MAX_RELAYED_ROWS_PER_HOST }, (_, index) => ({
        worktreeId: `r-${index}`
      }))
    ]
    const parsed = parseRelayedWorkspaceRows({ worktrees: rows })

    expect(parsed).toHaveLength(MAX_RELAYED_ROWS_PER_HOST)
    expect(parsed?.slice(0, 2)).toEqual([
      {
        worktreeId: 'w-1',
        displayName: '',
        branch: 'b'.repeat(MAX_RELAYED_TEXT_LENGTH),
        repo: 'orca',
        workspaceKind: 'git'
      },
      {
        worktreeId: 'w-folder',
        displayName: 'Notes',
        branch: '',
        repo: '',
        workspaceKind: 'folder-workspace'
      }
    ])
    expect(new Set(parsed?.map((row) => row.worktreeId)).size).toBe(MAX_RELAYED_ROWS_PER_HOST)
  })

  it('reports rows not fetched yet as unknown', () => {
    expect(parseRelayedWorkspaceRows({ worktrees: null })).toBeNull()
  })
})

describe('relayingRuntimeOwners', () => {
  it('never lists a WSL distro, whatever its status advertises', () => {
    const status: RuntimeStatus = {
      runtimeId: 'r',
      rendererGraphEpoch: 0,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0,
      capabilities: [RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY]
    }
    const base = {
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
      runtimeId: null,
      preferredEndpointId: 'e',
      endpoints: []
    }
    const environments: PublicKnownRuntimeEnvironment[] = [
      { ...base, id: 'server', name: 'Server' },
      {
        ...base,
        id: 'wsl',
        name: 'Ubuntu',
        orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 6001, remotePort: 6002 }
      }
    ]
    const owners = relayingRuntimeOwners({
      runtimeEnvironments: environments,
      runtimeStatusByEnvironmentId: new Map(
        environments.map((environment, index) => [
          environment.id,
          runtimeEnvironmentStatusFromSnapshot({
            environmentId: environment.id,
            pairingRevision: 1,
            sequence: index,
            checkedAt: 1,
            status,
            verification: 'verified',
            transport: 'ready'
          })
        ])
      )
    })
    expect(owners.map((owner) => owner.environmentId)).toEqual(['server'])
  })
})
