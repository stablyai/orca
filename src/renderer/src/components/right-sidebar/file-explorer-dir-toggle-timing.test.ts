// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import {
  RENAME_HOTSPOT_ATTR,
  isRenameHotspotTarget,
  resolveDirToggleTiming
} from './file-explorer-dir-toggle-timing'

describe('resolveDirToggleTiming', () => {
  it('toggles immediately when the click misses the rename hotspot', () => {
    expect(resolveDirToggleTiming({ fromRenameHotspot: false, clickCount: 1 })).toBe('immediate')
    // Why: the chevron and empty row area must stay instant even on a fast double click.
    expect(resolveDirToggleTiming({ fromRenameHotspot: false, clickCount: 2 })).toBe('immediate')
  })

  it('defers the first click on the filename so a double click can cancel it', () => {
    expect(resolveDirToggleTiming({ fromRenameHotspot: true, clickCount: 1 })).toBe('deferred')
  })

  it('drops the toggle on the second click, which belongs to the rename', () => {
    expect(resolveDirToggleTiming({ fromRenameHotspot: true, clickCount: 2 })).toBe('skip')
    expect(resolveDirToggleTiming({ fromRenameHotspot: true, clickCount: 3 })).toBe('skip')
  })
})

describe('isRenameHotspotTarget', () => {
  it('matches the filename element and its descendants', () => {
    const row = document.createElement('button')
    const name = document.createElement('span')
    name.setAttribute(RENAME_HOTSPOT_ATTR, '')
    const inner = document.createElement('em')
    name.appendChild(inner)
    row.appendChild(name)

    expect(isRenameHotspotTarget(name)).toBe(true)
    expect(isRenameHotspotTarget(inner)).toBe(true)
  })

  it('rejects the row chrome and non-element targets', () => {
    const row = document.createElement('button')
    const icon = document.createElement('svg')
    row.appendChild(icon)

    expect(isRenameHotspotTarget(icon)).toBe(false)
    expect(isRenameHotspotTarget(row)).toBe(false)
    expect(isRenameHotspotTarget(null)).toBe(false)
  })
})
