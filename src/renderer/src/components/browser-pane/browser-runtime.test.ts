import { beforeEach, describe, expect, it } from 'vitest'
import {
  _getEvictedBrowserTabCountForTest,
  clearEvictedBrowserTab,
  consumeEvictedBrowserTab,
  markEvictedBrowserTab
} from './browser-runtime'

describe('browser runtime eviction notices', () => {
  beforeEach(() => {
    clearEvictedBrowserTab('page-1')
    clearEvictedBrowserTab('page-2')
  })

  it('clears an eviction notice without waiting for the page to remount', () => {
    markEvictedBrowserTab('page-1')

    expect(_getEvictedBrowserTabCountForTest()).toBe(1)

    clearEvictedBrowserTab('page-1')

    expect(consumeEvictedBrowserTab('page-1')).toBe(false)
    expect(_getEvictedBrowserTabCountForTest()).toBe(0)
  })

  it('keeps active eviction notices consumable', () => {
    markEvictedBrowserTab('page-2')

    expect(consumeEvictedBrowserTab('page-2')).toBe(true)
    expect(consumeEvictedBrowserTab('page-2')).toBe(false)
  })
})
