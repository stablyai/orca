import { describe, expect, it } from 'vitest'
import { buildDiffEditorHideUnchangedOptions } from './diff-editor-hide-unchanged-options'

describe('buildDiffEditorHideUnchangedOptions', () => {
  it('enables collapsing only when the setting is explicitly on', () => {
    expect(buildDiffEditorHideUnchangedOptions(true)).toEqual({
      hideUnchangedRegions: { enabled: true }
    })
  })

  // Always emit the disabled option: Monaco retains old values when keys disappear, stranding collapsed regions after toggling off.
  it('emits an explicit disabled state for off, undefined, and legacy settings', () => {
    for (const value of [false, undefined]) {
      expect(buildDiffEditorHideUnchangedOptions(value)).toEqual({
        hideUnchangedRegions: { enabled: false }
      })
    }
  })
})
