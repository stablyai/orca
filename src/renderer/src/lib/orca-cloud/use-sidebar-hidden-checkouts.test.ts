import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { selectOrcaCloudHostIdsKey } from './use-sidebar-hidden-checkouts'

describe('selectOrcaCloudHostIdsKey', () => {
  it('names only Orca Cloud sandbox servers', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the selector reads only id, name and source.
    const state = {
      runtimeEnvironments: [
        { id: 'a', name: 'orca-sandbox-push-test sandbox 1a2b3c4d', source: 'ephemeral-vm' },
        { id: 'b', name: 'orca-sandbox-push-test sandbox 5e6f7a8b', source: 'ephemeral-vm' },
        { id: 'vm', name: 'my recipe VM', source: 'ephemeral-vm' },
        { id: 'manual', name: 'orca-sandbox-push-test sandbox 1a2b3c4d', source: 'manual' }
      ]
    } as unknown as Pick<AppState, 'runtimeEnvironments'>
    expect(selectOrcaCloudHostIdsKey(state).split('\n')).toEqual(['runtime:a', 'runtime:b'])
  })
})
