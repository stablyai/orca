import { expect, it } from 'vitest'
import type { WslHostStatus } from '../../../../shared/wsl-host-types'
import { createTestStore } from './store-test-helpers'

it('publishes a deferral-only change for an already-ready WSL host', () => {
  const store = createTestStore()
  const ready: WslHostStatus = {
    environmentId: 'wsl-ubuntu',
    distro: 'Ubuntu',
    state: 'ready',
    detail: null
  }
  store.getState().applyWslHostStatus(ready)
  const deferred: WslHostStatus = {
    ...ready,
    deferredUpdate: {
      candidateVersion: 'next',
      code: 'live-terminals',
      reason: 'Terminals are still running.',
      forceable: true
    }
  }
  store.getState().applyWslHostStatus(deferred)
  expect(store.getState().wslHostStatuses[ready.environmentId]).toEqual(deferred)
})
