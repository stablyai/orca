// @vitest-environment happy-dom
// Guards PR #47381: a catalog notice after one host is removed reads the host list a number of times
// linear in the hosts, not once per host per host.
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import { useBotSlackIcons } from './use-bot-slack-icons'

let hostIds: string[] = []
let reads = 0
let notify = (): void => {}
const noBots: Bot[] = []

vi.mock('@/lib/bot-catalog', () => ({
  readBotsEnabled: () => true,
  subscribeToBotChanges: (listener: () => void) => {
    notify = listener
    return () => {}
  },
  useBotsEnabled: () => true
}))
vi.mock('@/lib/bot-catalog-snapshot', () => ({
  readBotHostState: () => 'live',
  // Each element read of the list the notice is handed counts.
  readBotHostIds: () => {
    const counted: string[] = []
    hostIds.forEach((hostId, index) =>
      Object.defineProperty(counted, index, {
        enumerable: true,
        get: () => {
          reads += 1
          return hostId
        }
      })
    )
    return counted
  },
  // A distinct list per host, so each host is seen once.
  readHostBots: () => noBots
}))
vi.mock('@/lib/bot-host-status', () => ({ botHostHas: () => true }))
vi.mock('@/lib/bot-host-link-read', () => ({ onBotHostCameBack: () => () => {} }))
vi.mock('./bot-outfit-art', () => ({ allowOutfitReadsAgain: () => {} }))
vi.mock('./bot-slack-icon-raster', () => ({ drawBotSlackIcon: async () => 'cG5n' }))
vi.mock('./bot-slack-icon-rpc', () => ({
  botSlackIconWanted: async () => ({ wanted: false, current: true }),
  uploadBotSlackIcon: async () => true
}))

afterEach(cleanup)

function readsToRemoveOneHost(hosts: number): number {
  hostIds = Array.from({ length: hosts }, (_, index) => `host-${index}`)
  const { unmount } = renderHook(() => useBotSlackIcons())
  hostIds = hostIds.slice(1)
  reads = 0
  notify()
  unmount()
  return reads
}

it('reads the host list linearly when one host goes', () => {
  expect(readsToRemoveOneHost(10)).toBeLessThanOrEqual(30)
  expect(readsToRemoveOneHost(100)).toBeLessThanOrEqual(300)
})
