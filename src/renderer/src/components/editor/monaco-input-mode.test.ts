import { describe, expect, it } from 'vitest'

import { getDefaultSettings } from '../../../../shared/constants'

import { resolveEditorEditContextEnabled } from './monaco-input-mode'

describe('resolveEditorEditContextEnabled', () => {
  it('defaults to the legacy textarea input path when unset', () => {
    // Why: an unset value must NOT enable Chromium's EditContext; that path can
    // wedge all editors' typing until restart, so off-by-default is the safety
    // contract this whole change exists to guarantee.
    expect(resolveEditorEditContextEnabled(undefined)).toBe(false)
  })

  it('honors an explicit opt-out', () => {
    expect(resolveEditorEditContextEnabled(false)).toBe(false)
  })

  it('enables EditContext only when explicitly opted in', () => {
    expect(resolveEditorEditContextEnabled(true)).toBe(true)
  })

  it('keeps the shipped default off so editors use the reliable input path', () => {
    expect(getDefaultSettings('/home/test').editorExperimentalInput).toBe(false)
  })
})
