import { describe, expect, it } from 'vitest'
import { getDefaultPrimarySelectionMiddleClickPaste, getDefaultSettings } from './constants'

describe('getDefaultSettings', () => {
  it('enables gitignored file decorations by default', () => {
    expect(getDefaultSettings('/tmp').showGitIgnoredFiles).toBe(true)
  })
})

describe('getDefaultPrimarySelectionMiddleClickPaste', () => {
  it('enables primary selection paste on Linux by default', () => {
    expect(getDefaultPrimarySelectionMiddleClickPaste('linux')).toBe(true)
  })

  it('leaves primary selection paste opt-in on macOS and Windows', () => {
    expect(getDefaultPrimarySelectionMiddleClickPaste('darwin')).toBe(false)
    expect(getDefaultPrimarySelectionMiddleClickPaste('win32')).toBe(false)
  })
})
