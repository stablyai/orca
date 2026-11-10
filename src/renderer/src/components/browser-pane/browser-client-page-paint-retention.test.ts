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
  it('stays transparent and click-through over a pane hidden by an ancestor opacity', async () => {
    const rig = createRetainedHostFixture()
    // Inactive tabs kept paintable for agents or viewers are hidden by opacity, not display.
    const inactiveSlot = document.createElement('div')
    inactiveSlot.style.opacity = '0'
    document.body.appendChild(inactiveSlot)
    inactiveSlot.appendChild(rig.container)
    await rig.mount()

    rig.attach()

    expect(rig.host().style.opacity).toBe('0')
    expect(rig.host().style.pointerEvents).toBe('none')
    expect(rig.host().inert).toBe(true)
  })

  it('paints and accepts input over a shown pane', async () => {
    const rig = createRetainedHostFixture()
    await rig.mount()

    rig.attach()

    expect(rig.host().style.opacity).toBe('')
    expect(rig.host().style.pointerEvents).toBe('auto')
    expect(rig.host().style.left).toBe('0px')
    expect(rig.host().style.width).toBe('800px')
  })
})
