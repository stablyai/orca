import { describe, expect, it } from 'vitest'
import { WorkspaceViewControl } from './workspace-view-control'

describe('workspace view control', () => {
  it('keeps a single controller across duplicate views and hands off explicitly', () => {
    const control = new WorkspaceViewControl()
    control.register(1, [{ key: 'session', viewId: 'original' }])
    control.register(2, [{ key: 'session', viewId: 'copy' }])
    expect(control.snapshot()).toEqual({ session: { windowId: 1, viewId: 'original' } })
    expect(control.claim(2, 'session', 'copy')).toBe(true)
    expect(control.snapshot()).toEqual({ session: { windowId: 2, viewId: 'copy' } })
    expect(control.claim(3, 'session', 'forged')).toBe(false)
    control.register(2, [])
    expect(control.snapshot()).toEqual({ session: { windowId: 1, viewId: 'original' } })
  })
})
