import { describe, expect, it } from 'vitest'
import {
  areAllTabStripsAutoHidden,
  resolveSingleTabStripVisibility
} from './single-tab-strip-visibility'

const base = {
  autoHideEnabled: true,
  groupTabCount: 1,
  clientHostedRowCount: 0,
  stripHovered: false,
  tabDragActive: false
}

describe('resolveSingleTabStripVisibility', () => {
  it('keeps the strip in the flow while the setting is off', () => {
    expect(resolveSingleTabStripVisibility({ ...base, autoHideEnabled: false })).toEqual({
      autoHidden: false,
      revealed: false
    })
  })

  it('collapses a lone tab', () => {
    expect(resolveSingleTabStripVisibility(base).autoHidden).toBe(true)
  })

  it('keeps the strip for an empty group, which has no other way back to a tab', () => {
    expect(resolveSingleTabStripVisibility({ ...base, groupTabCount: 0 }).autoHidden).toBe(false)
  })

  it('keeps the strip for a second tab', () => {
    expect(resolveSingleTabStripVisibility({ ...base, groupTabCount: 2 }).autoHidden).toBe(false)
  })

  it('keeps the strip when a client-hosted browser row shares it', () => {
    expect(resolveSingleTabStripVisibility({ ...base, clientHostedRowCount: 1 }).autoHidden).toBe(
      false
    )
  })

  it('reveals a collapsed strip on hover and for the duration of a tab drag', () => {
    expect(resolveSingleTabStripVisibility({ ...base, stripHovered: true }).revealed).toBe(true)
    expect(resolveSingleTabStripVisibility({ ...base, tabDragActive: true }).revealed).toBe(true)
  })

  it('never reports a reveal for a strip that was never collapsed', () => {
    expect(
      resolveSingleTabStripVisibility({ ...base, groupTabCount: 3, stripHovered: true }).revealed
    ).toBe(false)
  })
})

describe('areAllTabStripsAutoHidden', () => {
  const base = { autoHideEnabled: true, clientHostedRowCount: 0 }

  it('holds only when every group collapsed', () => {
    expect(areAllTabStripsAutoHidden({ ...base, groupTabCounts: [1, 1] })).toBe(true)
    expect(areAllTabStripsAutoHidden({ ...base, groupTabCounts: [1, 2] })).toBe(false)
  })

  it('does not hold for a worktree with no groups or with the setting off', () => {
    expect(areAllTabStripsAutoHidden({ ...base, groupTabCounts: [] })).toBe(false)
    expect(
      areAllTabStripsAutoHidden({ ...base, autoHideEnabled: false, groupTabCounts: [1] })
    ).toBe(false)
  })

  it('does not hold while a client-hosted browser row still needs the strip', () => {
    expect(
      areAllTabStripsAutoHidden({ ...base, groupTabCounts: [1], clientHostedRowCount: 1 })
    ).toBe(false)
  })
})
