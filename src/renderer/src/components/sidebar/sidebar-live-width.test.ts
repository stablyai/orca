// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { setSidebarLiveWidth, trackSidebarLiveWidth } from './sidebar-live-width'

const read = (el: HTMLElement): string =>
  el.style.getPropertyValue('--workspace-sidebar-live-width')

describe('sidebar live width', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

  it('scopes drag width to mounted drawers instead of the document root', () => {
    setSidebarLiveWidth(300)
    const drawer = document.createElement('div')
    cleanups.push(trackSidebarLiveWidth(drawer)!)
    // A drawer opened mid-drag starts at the live edge, not the persisted width.
    expect(read(drawer)).toBe('300px')

    setSidebarLiveWidth(312)
    expect(read(drawer)).toBe('312px')
    expect(read(document.documentElement)).toBe('')

    cleanups.pop()!()
    setSidebarLiveWidth(330)
    expect(read(drawer)).toBe('312px')
  })
})
