import { describe, expect, it } from 'vitest'
import {
  createTestStore,
  runtimeOwnedRepoState,
  seedStore
} from '../../store/slices/store-test-helpers'
import type { RuntimeHostStatusSnapshot } from '../../../../shared/runtime-host-status'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { selectManagedPairingRefusedEnvironmentId } from './use-managed-pairing-refused'

const WORKTREE = 'box-repo::/home/me/app'

function stateWith(
  deployment: PublicKnownRuntimeEnvironment['orcadDeployment'],
  snapshot: Partial<RuntimeHostStatusSnapshot>
) {
  const store = createTestStore()
  seedStore(store, {
    ...runtimeOwnedRepoState('box', 'box-repo', '/home/me/app'),
    runtimeEnvironments: [
      {
        id: 'box',
        name: 'Box server',
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: null,
        runtimeId: null,
        preferredEndpointId: 'ws',
        endpoints: [],
        ...(deployment ? { orcadDeployment: deployment } : {})
      }
    ]
  })
  store.setState({
    runtimeStatusByEnvironmentId: new Map([
      [
        'box',
        {
          status: null,
          checkedAt: 1,
          snapshot: {
            environmentId: 'box',
            pairingRevision: 0,
            sequence: 1,
            checkedAt: 1,
            status: null,
            verification: 'blocked',
            transport: 'disconnected',
            blockedReason: 'access-revoked',
            ...snapshot
          }
        }
      ]
    ])
  })
  return store.getState()
}

const SSH = { sshTargetId: 'box', sshTargetGeneration: 1, localPort: 46_768, remotePort: 6_768 }

describe('selectManagedPairingRefusedEnvironmentId', () => {
  it('names a server managed over SSH that refused this desktop after a failed re-pair', () => {
    expect(selectManagedPairingRefusedEnvironmentId(stateWith(SSH, {}), WORKTREE)).toBe('box')
  })

  const quiet: [string, typeof SSH | undefined, Partial<RuntimeHostStatusSnapshot>][] = [
    ['a server the user pairs with a link', undefined, {}],
    ['a server that is only unavailable', SSH, { verification: 'unavailable' }],
    ['an incompatible server', SSH, { blockedReason: 'incompatible' }],
    ['a retired status owner', SSH, { retired: true }]
  ]
  it.each(quiet)('stays quiet for %s', (_name, deployment, snapshot) => {
    expect(
      selectManagedPairingRefusedEnvironmentId(stateWith(deployment, snapshot), WORKTREE)
    ).toBeNull()
  })
})
