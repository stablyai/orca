import { afterEach, expect, it, vi } from 'vitest'
import {
  browserGuestActivity,
  registerBrowserGuestActivity,
  setBrowserGuestVisible,
  unregisterBrowserGuestActivity,
  touchBrowserGuestActivity,
  reportBrowserGuestVisibility
} from './browser-guest-activity'
import { installBrowserGuestPageRetention } from './browser-guest-page-retention'
import type { BrowserGuestIdleDiscardRequest } from '../../../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'

const stops: (() => void)[] = []
afterEach(() => {
  stops.splice(0).forEach((stop) => stop())
  browserGuestActivity.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
function fixture() {
  let due: (request: BrowserGuestIdleDiscardRequest) => void = () => {}
  const report = vi.fn()
  const refuse = vi.fn()
  vi.stubGlobal('window', {
    api: {
      browser: {
        reportGuestVisibility: report,
        refuseGuestIdleDiscard: refuse,
        onGuestIdleDiscardDue: (callback: typeof due) => {
          due = callback
          return () => {}
        }
      }
    }
  })
  const discard = vi.fn(() => true)
  const blocked = new Set<string>()
  const install = () =>
    stops.push(installBrowserGuestPageRetention({ isBlocked: (id) => blocked.has(id), discard }))
  const add = (id: number) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the policy bridge reads only this native guest identity.
    registerBrowserGuestActivity(`page-${id}`, {
      getWebContentsId: () => id
    } as Electron.WebviewTag)
  }
  const request = (id: number): BrowserGuestIdleDiscardRequest => ({
    browserPageId: `page-${id}`,
    webContentsId: id,
    visible: false,
    generation: browserGuestActivity.get(`page-${id}`)!.visibilityGeneration,
    policyToken: {
      rendererId: 99,
      generation: browserGuestActivity.get(`page-${id}`)!.visibilityGeneration
    }
  })
  return {
    add,
    install,
    report,
    refuse,
    discard,
    blocked,
    request,
    due: (request: BrowserGuestIdleDiscardRequest) => due(request)
  }
}

it('checks exact guest, visibility episode and final local veto before synchronous discard', () => {
  const f = fixture()
  f.install()
  f.add(1)
  const unknown = f.request(1)
  f.due(unknown)
  setBrowserGuestVisible('page-1', false)
  const hidden = f.request(1)
  setBrowserGuestVisible('page-1', true)
  f.due(hidden)
  setBrowserGuestVisible('page-1', false)
  f.due(hidden)
  f.blocked.add('page-1')
  f.due(f.request(1))
  f.blocked.clear()
  f.due({ ...f.request(1), webContentsId: 2 })
  expect(f.discard).not.toHaveBeenCalled()
  const fresh = f.request(1)
  f.due(fresh)
  expect(f.discard).toHaveBeenCalledWith(
    'page-1',
    browserGuestActivity.get('page-1')!.webview,
    1,
    fresh.policyToken
  )
  expect(f.refuse).toHaveBeenCalledTimes(5)
})

it('reports current visibility when registration completes, without treating registration as another hide', () => {
  const f = fixture()
  f.add(1)
  setBrowserGuestVisible('page-1', true)
  const before = f.request(1).generation
  f.report.mockClear()
  reportBrowserGuestVisibility('page-1')
  expect(f.report).toHaveBeenCalledWith({
    browserPageId: 'page-1',
    webContentsId: 1,
    generation: before,
    visible: true
  })
  setBrowserGuestVisible('page-1', true)
  touchBrowserGuestActivity('page-1')
  expect(f.report).toHaveBeenCalledTimes(1)
})

it.each([200, 2000])('keeps ordinary activity and one due event page-local at N=%i', (count) => {
  const f = fixture()
  for (let id = 1; id <= count; id++) {
    f.add(id)
    setBrowserGuestVisible(`page-${id}`, false)
  }
  f.install()
  f.report.mockClear()
  const reads = vi.spyOn(browserGuestActivity, 'get')
  for (let turn = 0; turn < 10; turn++) {
    touchBrowserGuestActivity('page-1')
  }
  f.due(f.request(1))
  expect(reads.mock.calls.every(([id]) => id === 'page-1')).toBe(true)
  expect(f.report).not.toHaveBeenCalled()
  expect(f.discard).toHaveBeenCalledTimes(1)
  expect(browserGuestActivity.size).toBe(count)
  unregisterBrowserGuestActivity('page-1')
})
