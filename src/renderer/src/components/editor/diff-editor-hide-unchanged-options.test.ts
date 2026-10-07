import { describe, expect, it } from 'vitest'
import { buildDiffEditorHideUnchangedOptions } from './diff-editor-hide-unchanged-options'

describe('buildDiffEditorHideUnchangedOptions', () => {
  it('enables collapsing only when the setting is explicitly on', () => {
    expect(buildDiffEditorHideUnchangedOptions(true)).toEqual({
      hideUnchangedRegions: { enabled: true }
    })
  })

  // Why: the option must always be present, not omitted when off. Monaco keeps the last applied
  // value across an options update, so dropping the key would strand a diff editor in collapsed
  // mode after the user turns the setting back off.
  it('emits an explicit disabled state for off, undefined, and legacy settings', () => {
    for (const value of [false, undefined]) {
      expect(buildDiffEditorHideUnchangedOptions(value)).toEqual({
        hideUnchangedRegions: { enabled: false }
      })
    }
  })
})
