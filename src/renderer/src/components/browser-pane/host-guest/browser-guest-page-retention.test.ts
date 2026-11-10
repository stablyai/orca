import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  browserGuestActivity,
  registerBrowserGuestActivity,
  setBrowserGuestVisible,
  touchBrowserGuestActivity,
  updateBrowserGuestProtection,
  unregisterBrowserGuestActivity
} from './browser-guest-activity'
import {
  acquireBrowserAutomationVisibility,
  releaseBrowserAutomationVisibility,
  isBrowserAutomationVisible,
  onBrowserAutomationVisibilityChange
} from './browser-automation-visibility'
import { installBrowserGuestPageRetention } from './browser-guest-page-retention'
import type { BrowserGuestDiscardProtection } from '../../../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'

const stops: (() => void)[] = []
const clean = (id: number): BrowserGuestDiscardProtection => ({
  webContentsId: id,
  protection: 'discardable',
  reason: 'clean'
})
function guest(id: number): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This controller fixture reads only the guest identity method.
  registerBrowserGuestActivity(`page-${id}`, { getWebContentsId: () => id } as Electron.WebviewTag)
  setBrowserGuestVisible(`page-${id}`, false)
}
function destroy(pageId: string): void {
  unregisterBrowserGuestActivity(pageId)
}
afterEach(() => {
  for (const stop of stops.splice(0)) {
    stop()
  }
  for (const id of browserGuestActivity.keys()) {
    unregisterBrowserGuestActivity(id)
  }
  vi.useRealTimers()
})

describe('hidden guest page pool', () => {
  it.each([200, 2000])(
    'reclaims a %i-page fleet to twenty idle pages with bounded admission',
    async (count) => {
      for (let id = 1; id <= count; id++) {
        guest(id)
      }
      let inFlight = 0
      let maximum = 0
      const query = vi.fn(async (_pageId: string, id: number) => {
        inFlight += 1
        maximum = Math.max(maximum, inFlight)
        await Promise.resolve()
        inFlight -= 1
        return clean(id)
      })
      stops.push(
        installBrowserGuestPageRetention({ isBlocked: () => false, getProtection: query, destroy })
      )
      await vi.waitFor(() => expect(browserGuestActivity.size).toBe(20))
      expect([...browserGuestActivity.keys()]).toEqual(
        Array.from({ length: 20 }, (_, index) => `page-${count - 19 + index}`)
      )
      expect(query).toHaveBeenCalledTimes(count - 20)
      expect(maximum).toBeLessThanOrEqual(4)
    }
  )

  it('parks uncertain pages without idle work and converges when their observer reports', async () => {
    for (let id = 1; id <= 40; id++) {
      guest(id)
    }
    const unknown = new Set([1, 2, 3, 4])
    const query = vi.fn(async (_pageId: string, id: number) => (unknown.has(id) ? null : clean(id)))
    stops.push(
      installBrowserGuestPageRetention({ isBlocked: () => false, getProtection: query, destroy })
    )
    await vi.waitFor(() => expect(browserGuestActivity.size).toBe(24))
    expect(query).toHaveBeenCalledTimes(20)
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(query).toHaveBeenCalledTimes(20)
    unknown.clear()
    for (let id = 1; id <= 4; id++) {
      touchBrowserGuestActivity(`page-${id}`)
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(browserGuestActivity.size).toBe(20)
    expect(browserGuestActivity.has('page-1')).toBe(true)
  })

  it('rebuilds retention from actual use across controller disposal', async () => {
    for (let id = 1; id <= 21; id++) {
      guest(id)
    }
    setBrowserGuestVisible('page-21', true)
    const first = installBrowserGuestPageRetention({
      isBlocked: () => false,
      getProtection: async (_id, id) => clean(id),
      destroy
    })
    first()
    setBrowserGuestVisible('page-21', false)
    setBrowserGuestVisible('page-1', true)
    setBrowserGuestVisible('page-1', false)
    stops.push(
      installBrowserGuestPageRetention({
        isBlocked: () => false,
        getProtection: async (_id, id) => clean(id),
        destroy
      })
    )
    await vi.waitFor(() => expect(browserGuestActivity.size).toBe(20))
    expect(browserGuestActivity.has('page-1')).toBe(true)
    expect(browserGuestActivity.has('page-2')).toBe(false)
  })

  it.each([200, 2000])(
    'does not inspect untouched owners across %i protected pages',
    async (count) => {
      for (let id = 1; id <= count + 20; id++) {
        guest(id)
        if (id <= count) {
          updateBrowserGuestProtection({
            browserPageId: `page-${id}`,
            webContentsId: id,
            protection: 'unknown',
            reason: 'frames'
          })
        }
      }
      const inspected = vi.fn(
        (id: string) =>
          browserGuestActivity.get(id)?.protection === 'unknown' || isBrowserAutomationVisible(id)
      )
      const query = vi.fn(async (_id: string, id: number) => clean(id))
      stops.push(
        installBrowserGuestPageRetention({ isBlocked: inspected, getProtection: query, destroy })
      )
      const stopProducer = onBrowserAutomationVisibilityChange(touchBrowserGuestActivity)
      stops.push(stopProducer)
      inspected.mockClear()
      for (let command = 0; command < 40; command++) {
        const token = acquireBrowserAutomationVisibility('page-1')
        releaseBrowserAutomationVisibility(token)
        await Promise.resolve()
      }
      expect(inspected.mock.calls.every(([id]) => id === 'page-1')).toBe(true)
      expect(query).not.toHaveBeenCalled()
      updateBrowserGuestProtection({
        browserPageId: 'page-1',
        webContentsId: 1,
        protection: 'discardable',
        reason: 'clean'
      })
      await vi.waitFor(() => expect(browserGuestActivity.size).toBe(count + 19))
      expect(query.mock.calls).toEqual([[`page-${count + 1}`, count + 1]])
      expect(browserGuestActivity.has('page-1')).toBe(true)
    }
  )

  it.each(['show-edit-hide', 'claim-use-release', 'replacement', 'navigation'])(
    'rejects a clean reply predating %s',
    async (transition) => {
      for (let id = 1; id <= 21; id++) {
        guest(id)
      }
      let answer: (result: BrowserGuestDiscardProtection) => void = () => {}
      const blocked = new Set<string>()
      let queries = 0
      const query = vi.fn((_pageId: string, id: number) =>
        ++queries === 1
          ? new Promise<BrowserGuestDiscardProtection>((resolve) => {
              answer = resolve
            })
          : Promise.resolve(clean(id))
      )
      stops.push(
        installBrowserGuestPageRetention({
          isBlocked: (id) => blocked.has(id),
          getProtection: query,
          destroy
        })
      )
      await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1))
      if (transition === 'show-edit-hide') {
        setBrowserGuestVisible('page-1', true)
        touchBrowserGuestActivity('page-1')
        setBrowserGuestVisible('page-1', false)
      } else if (transition === 'claim-use-release') {
        blocked.add('page-1')
        touchBrowserGuestActivity('page-1')
        blocked.delete('page-1')
        touchBrowserGuestActivity('page-1')
      } else if (transition === 'replacement') {
        guest(1)
      } else {
        touchBrowserGuestActivity('page-1')
      }
      answer(clean(1))
      await vi.waitFor(() => expect(browserGuestActivity.size).toBe(20))
      expect(browserGuestActivity.has('page-1')).toBe(true)
      expect(browserGuestActivity.has('page-2')).toBe(false)
    }
  )

  it('keeps a page used after selection but before its protection request is admitted', async () => {
    for (let id = 1; id <= 26; id++) {
      guest(id)
    }
    const answers = new Map<number, (result: BrowserGuestDiscardProtection) => void>()
    const query = vi.fn((_pageId: string, id: number) =>
      id <= 4
        ? new Promise<BrowserGuestDiscardProtection>((resolve) => answers.set(id, resolve))
        : Promise.resolve(clean(id))
    )
    stops.push(
      installBrowserGuestPageRetention({ isBlocked: () => false, getProtection: query, destroy })
    )
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(4))
    setBrowserGuestVisible('page-5', true)
    setBrowserGuestVisible('page-5', false)
    for (const [id, answer] of answers) {
      answer(clean(id))
    }
    await vi.waitFor(() => expect(browserGuestActivity.size).toBe(20))
    expect(browserGuestActivity.has('page-5')).toBe(true)
    expect(browserGuestActivity.has('page-6')).toBe(false)
    expect(browserGuestActivity.has('page-7')).toBe(false)
  })

  it('keeps visible and actively used pages while reclaiming their idle siblings, and fences teardown', async () => {
    for (let id = 1; id <= 24; id++) {
      guest(id)
    }
    setBrowserGuestVisible('page-1', true)
    const blocked = new Set(['page-2', 'page-3'])
    let answer: (result: BrowserGuestDiscardProtection) => void = () => {}
    const query = vi.fn(
      (_pageId: string, _id: number) =>
        new Promise<BrowserGuestDiscardProtection>((resolve) => {
          answer = resolve
        })
    )
    const stop = installBrowserGuestPageRetention({
      isBlocked: (id) => blocked.has(id),
      getProtection: query,
      destroy
    })
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1))
    expect(query.mock.calls[0]).toEqual(['page-4', 4])
    stop()
    answer(clean(4))
    await Promise.resolve()
    expect(browserGuestActivity.size).toBe(24)
  })
})
