import { beforeEach, expect, it, vi } from 'vitest'

const activate = vi.hoisted(() => vi.fn(async () => true))
const revision = vi.hoisted(() => ({ current: 3 as number | undefined }))

vi.mock('@/runtime/web-session-tabs-sync/actions/web-runtime-session-tab-lifecycle', () => ({
  activateWebRuntimeSessionTab: activate
}))
vi.mock('@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: (environmentId: string | null) => environmentId === 'env-1',
  captureWebSessionIntentOwner: (environmentId: string) => ({
    environmentId,
    pairingRevision: revision.current
  })
}))
vi.mock('@/runtime/web-session-tabs-sync/navigation/web-session-focus-intent', () => ({
  resolveWebSessionVisibleTabId: () => null
}))

import { activateTerminalTabOnOwner } from './terminal-tab-owner-activation'

beforeEach(() => {
  activate.mockClear()
  revision.current = 3
})

it('binds owner activation to the pairing current at the gesture', () => {
  activateTerminalTabOnOwner('repo::/sample', 'tab-1', 'leaf-1', 'env-1')
  // A pairing replaced while activation awaits its lazy module must not adopt the new peer.
  revision.current = 4

  expect(activate).toHaveBeenCalledTimes(1)
  expect(activate).toHaveBeenCalledWith(
    expect.objectContaining({ environmentId: 'env-1', expectedPairingRevision: 3 })
  )
})

it('keeps a revision the caller already captured', () => {
  activateTerminalTabOnOwner('repo::/sample', 'tab-1', 'leaf-1', 'env-1', 2)

  expect(activate).toHaveBeenCalledWith(expect.objectContaining({ expectedPairingRevision: 2 }))
})
