import { describe, expect, it } from 'vitest'
import {
  isCtrlCmdSwapActive,
  modifiersNeedSwap,
  normalizeModifierRemap,
  swapCtrlCmd
} from './modifier-remap'

describe('normalizeModifierRemap', () => {
  it('defaults anything unrecognized to none', () => {
    expect(normalizeModifierRemap(undefined)).toBe('none')
    expect(normalizeModifierRemap(null)).toBe('none')
    expect(normalizeModifierRemap('nonsense')).toBe('none')
    expect(normalizeModifierRemap(true)).toBe('none')
    expect(normalizeModifierRemap('swap-ctrl-cmd')).toBe('swap-ctrl-cmd')
  })
})

describe('isCtrlCmdSwapActive', () => {
  it('only activates on darwin', () => {
    expect(isCtrlCmdSwapActive('swap-ctrl-cmd', 'darwin')).toBe(true)
    expect(isCtrlCmdSwapActive('swap-ctrl-cmd', 'linux')).toBe(false)
    expect(isCtrlCmdSwapActive('swap-ctrl-cmd', 'win32')).toBe(false)
  })

  it('stays off for the default setting', () => {
    expect(isCtrlCmdSwapActive('none', 'darwin')).toBe(false)
    expect(isCtrlCmdSwapActive(undefined, 'darwin')).toBe(false)
  })
})

describe('swapCtrlCmd', () => {
  it('exchanges the two modifiers in both directions', () => {
    expect(swapCtrlCmd({ control: true, meta: false })).toEqual({ control: false, meta: true })
    expect(swapCtrlCmd({ control: false, meta: true })).toEqual({ control: true, meta: false })
  })

  it('leaves both-set and neither-set states alone', () => {
    expect(swapCtrlCmd({ control: true, meta: true })).toEqual({ control: true, meta: true })
    expect(swapCtrlCmd({ control: false, meta: false })).toEqual({ control: false, meta: false })
  })

  it('is its own inverse', () => {
    for (const control of [true, false]) {
      for (const meta of [true, false]) {
        expect(swapCtrlCmd(swapCtrlCmd({ control, meta }))).toEqual({ control, meta })
      }
    }
  })
})

describe('modifiersNeedSwap', () => {
  it('is false when swapping would be a no-op', () => {
    expect(modifiersNeedSwap({ control: false, meta: false })).toBe(false)
    expect(modifiersNeedSwap({ control: true, meta: true })).toBe(false)
    expect(modifiersNeedSwap({ control: true, meta: false })).toBe(true)
    expect(modifiersNeedSwap({ control: false, meta: true })).toBe(true)
  })
})
