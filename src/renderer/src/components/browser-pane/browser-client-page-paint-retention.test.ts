// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  createRetainedHostFixture,
  disposeRetainedHostFixtures
} from './browser-client-page-retained-host-fixture'

afterEach(() => {
  disposeRetainedHostFixtures()
  document.body.innerHTML = ''
})

describe('client-hosted retained host paint', () => {
  it('goes transparent and click-through while its tab is switched away, then returns', async () => {
    const rig = createRetainedHostFixture()
    // Inactive tabs kept paintable for agents or viewers are hidden by slot opacity, not display.
    const slot = document.createElement('div')
    document.body.appendChild(slot)
    slot.appendChild(rig.container)
    await rig.mount()
    rig.attach()
    const host = rig.host()
    expect(host.style.opacity).toBe('')
    expect(host.style.pointerEvents).toBe('auto')

    slot.style.opacity = '0'
    window.dispatchEvent(new Event('resize'))

    expect(host.style.opacity).toBe('0')
    expect(host.style.pointerEvents).toBe('none')
    expect(host.inert).toBe(true)
    expect(host.style.width).toBe('800px')

    slot.style.opacity = '1'
    window.dispatchEvent(new Event('resize'))

    expect(host.style.opacity).toBe('')
    expect(host.style.pointerEvents).toBe('auto')
    expect(host.inert).toBe(false)
  })
})
