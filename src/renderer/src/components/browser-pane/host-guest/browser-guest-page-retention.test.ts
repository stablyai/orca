import { afterEach, expect, it, vi } from 'vitest'
import {
  browserGuestActivity,
  registerBrowserGuestActivity,
  setBrowserGuestVisible,
  unregisterBrowserGuestActivity,
  retiredBrowserGuestResources,
  setBrowserGuestResourceRetired,
  touchBrowserGuestActivity
} from './browser-guest-activity'
import { installBrowserGuestPageRetention } from './browser-guest-page-retention'

const stops: (() => void)[] = []
function guest(id: number): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pool reads only native guest identity.
  registerBrowserGuestActivity(`page-${id}`, { getWebContentsId: () => id } as Electron.WebviewTag)
}
afterEach(() => {
  retiredBrowserGuestResources.clear()
  stops.splice(0).forEach((stop) => stop())
  for (const id of browserGuestActivity.keys()) {
    unregisterBrowserGuestActivity(id)
  }
})
it.each([200, 2000])(
  'reclaims only eligible excess from a %i-page window without scanning held owners on activity',
  async (count) => {
    for (let id = 1; id <= count; id++) {
      guest(id)
    }
    const blocked = new Set(['page-1', 'page-2'])
    const inspect = vi.fn((id: string) => blocked.has(id))
    const discard = vi.fn((id: string) => {
      unregisterBrowserGuestActivity(id)
      return true
    })
    stops.push(installBrowserGuestPageRetention({ isBlocked: inspect, discard }))
    await Promise.resolve()
    expect(browserGuestActivity.size).toBe(32)
    // The two held pages count toward the budget, so only30 clean pages remain.
    expect([...browserGuestActivity.keys()]).toEqual([
      'page-1',
      'page-2',
      ...Array.from({ length: 30 }, (_, i) => `page-${count - 29 + i}`)
    ])
    inspect.mockClear()
    for (let i = 0; i < 10; i++) {
      touchBrowserGuestActivity('page-1')
      await Promise.resolve()
    }
    expect(inspect.mock.calls.every(([id]) => id === 'page-1')).toBe(true)
  }
)
it('keeps selected, protected and recently deselected pages; disposal prevents reclamation', async () => {
  for (let id = 1; id <= 40; id++) {
    guest(id)
  }
  setBrowserGuestVisible('page-1', true)
  setBrowserGuestVisible('page-2', true)
  setBrowserGuestVisible('page-2', false)
  const discard = (id: string): boolean => {
    unregisterBrowserGuestActivity(id)
    return true
  }
  const stop = installBrowserGuestPageRetention({ isBlocked: (id) => id === 'page-3', discard })
  stops.push(stop)
  await Promise.resolve()
  expect(browserGuestActivity.has('page-1')).toBe(true)
  expect(browserGuestActivity.has('page-2')).toBe(true)
  expect(browserGuestActivity.has('page-3')).toBe(true)
  expect(browserGuestActivity.has('page-4')).toBe(false)
  expect(browserGuestActivity.size).toBe(33)
  stop()
  guest(41)
  await Promise.resolve()
  expect(browserGuestActivity.has('page-41')).toBe(true)
})

it.each([100, 1000])(
  'parks %i main-refused owners and only retries the owner whose lifecycle changed',
  async (count) => {
    for (let id = 1; id <= count; id++) {
      guest(id)
    }
    const discard = vi.fn(() => false)
    stops.push(installBrowserGuestPageRetention({ isBlocked: () => false, discard }))
    await Promise.resolve()
    expect(browserGuestActivity.size).toBe(count)
    discard.mockClear()
    guest(count + 1)
    await Promise.resolve()
    expect(discard.mock.calls).toEqual([[`page-${count + 1}`, expect.anything(), count + 1]])
    discard.mockClear()
    touchBrowserGuestActivity('page-1')
    await Promise.resolve()
    expect(discard.mock.calls).toEqual([['page-1', expect.anything(), 1]])
  }
)

it('counts unconfirmed native removals until destruction while letting a replacement remain live', async () => {
  for (let id = 1; id <= 34; id++) {
    guest(id)
  }
  const discard = vi.fn((id: string, _guest: Electron.WebviewTag, contentsId: number) => {
    setBrowserGuestResourceRetired(id, contentsId, true)
    unregisterBrowserGuestActivity(id)
    return true
  })
  stops.push(installBrowserGuestPageRetention({ isBlocked: () => false, discard }))
  await Promise.resolve()
  expect(retiredBrowserGuestResources.size).toBe(4)
  expect(browserGuestActivity.size).toBe(30)
  for (const id of retiredBrowserGuestResources) {
    setBrowserGuestResourceRetired(`page-${id}`, id, false)
  }
  await Promise.resolve()
  expect(browserGuestActivity.size).toBe(30)
})
