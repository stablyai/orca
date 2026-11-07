import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import type { RuntimeEnvironmentStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { resolveBrowserRouteHostConnection } from './worktree-host-connection-phase'

const RECIPE_TARGET = 'runtime-ssh-vm-1'

function stateWith(entry: RuntimeEnvironmentStatus | undefined): AppState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only these fields.
  return {
    runtimeEnvironments: [
      {
        id: 'env-recipe',
        orcadDeployment: { sshTargetId: RECIPE_TARGET, sshTargetGeneration: 1 }
      }
    ],
    runtimeStatusByEnvironmentId: new Map(entry ? [['env-recipe', entry]] : []),
    sshConnectionStates: new Map()
  } as unknown as AppState
}

describe('browser route host connection for a recipe VM', () => {
  it('waits only while the recipe server is being dialed', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an awaiting handshake needs no other fields here.
    const dialing = {
      status: null,
      remoteControl: { state: 'awaiting_ready' },
      checkedAt: 1
    } as RuntimeEnvironmentStatus
    expect(resolveBrowserRouteHostConnection(stateWith(dialing), 'wt', RECIPE_TARGET)).toEqual(
      expect.objectContaining({
        phase: 'connecting',
        targetId: RECIPE_TARGET,
        connectedEpoch: null
      })
    )
  })

  it('settles when the recipe server was never reached, so the route offers recovery', () => {
    expect(resolveBrowserRouteHostConnection(stateWith(undefined), 'wt', RECIPE_TARGET).phase).toBe(
      'unavailable'
    )
  })

  it('names a new connected epoch when the recipe server is reached again', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a ready status needs no other fields here.
    const status = { graphStatus: 'ready' } as RuntimeEnvironmentStatus['status']
    const first = resolveBrowserRouteHostConnection(
      stateWith({ status, checkedAt: 1, connectionGeneration: 3, hostContactEpoch: 1 }),
      'wt',
      RECIPE_TARGET
    )
    const second = resolveBrowserRouteHostConnection(
      stateWith({ status, checkedAt: 2, connectionGeneration: 3, hostContactEpoch: 2 }),
      'wt',
      RECIPE_TARGET
    )

    expect(first.phase).toBe('connected')
    expect(first.connectedEpoch).not.toBeNull()
    expect(second.connectedEpoch).not.toBe(first.connectedEpoch)
  })
})
