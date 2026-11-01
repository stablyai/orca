import { describe, expect, it } from 'vitest'
import { canShowRightSidebarForView } from './right-sidebar-visibility'

describe('canShowRightSidebarForView', () => {
  it('keeps the auxiliary sidebar out of plugin main pages', () => {
    expect(canShowRightSidebarForView('plugin:samples.one/dashboard')).toBe(false)
    expect(canShowRightSidebarForView('terminal')).toBe(true)
  })
})
