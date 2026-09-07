// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { isPortaledRowMenuClick, isRowActivationKey } from './list-row-interaction'

describe('isPortaledRowMenuClick', () => {
  it('detects clicks whose target is outside the row DOM', () => {
    const row = document.createElement('div')
    const portaledMenuItem = document.createElement('div')
    document.body.append(row, portaledMenuItem)

    expect(
      isPortaledRowMenuClick({
        target: portaledMenuItem,
        currentTarget: row
      })
    ).toBe(true)

    row.remove()
    portaledMenuItem.remove()
  })

  it('allows in-row clicks', () => {
    const row = document.createElement('div')
    const child = document.createElement('span')
    row.append(child)

    expect(
      isPortaledRowMenuClick({
        target: child,
        currentTarget: row
      })
    ).toBe(false)
  })
})

describe('isRowActivationKey', () => {
  it('accepts Enter and Space on the row itself', () => {
    const row = document.createElement('div')

    expect(isRowActivationKey({ key: 'Enter', target: row, currentTarget: row })).toBe(true)
    expect(isRowActivationKey({ key: ' ', target: row, currentTarget: row })).toBe(true)
    expect(isRowActivationKey({ key: 'a', target: row, currentTarget: row })).toBe(false)
    expect(isRowActivationKey({ key: 'Tab', target: row, currentTarget: row })).toBe(false)
  })

  it('ignores keys pressed on a nested control', () => {
    const row = document.createElement('div')
    const trigger = document.createElement('button')
    row.append(trigger)

    expect(isRowActivationKey({ key: 'Enter', target: trigger, currentTarget: row })).toBe(false)
    expect(isRowActivationKey({ key: ' ', target: trigger, currentTarget: row })).toBe(false)
  })
})
