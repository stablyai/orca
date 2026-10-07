import { describe, expect, it } from 'vitest'
import {
  DEFAULT_INTERFACE_GLASS_OPACITY,
  DEFAULT_NATIVE_CHAT_GLASS_OPACITY,
  MIN_GLASS_OPACITY,
  formatWindowGlassArgument,
  hasWindowGlassArgument,
  normalizeInterfaceGlassOpacity,
  normalizeNativeChatGlassOpacity,
  shouldCreateGlassWindow
} from './window-glass'

describe('window glass', () => {
  it('only creates a glass window on macOS with blur enabled', () => {
    expect(shouldCreateGlassWindow('darwin', true)).toBe(true)
    expect(shouldCreateGlassWindow('darwin', false)).toBe(false)
    expect(shouldCreateGlassWindow('win32', true)).toBe(false)
    expect(shouldCreateGlassWindow('linux', true)).toBe(false)
  })

  it('round-trips the renderer argument', () => {
    expect(hasWindowGlassArgument(['electron', formatWindowGlassArgument()])).toBe(true)
    expect(hasWindowGlassArgument(['electron', '--orca-window-glass-other'])).toBe(false)
  })

  it('clamps chat glass opacity and falls back on invalid values', () => {
    expect(normalizeNativeChatGlassOpacity(0.4)).toBe(0.4)
    expect(normalizeNativeChatGlassOpacity(0)).toBe(MIN_GLASS_OPACITY)
    expect(normalizeNativeChatGlassOpacity(3)).toBe(1)
    expect(normalizeNativeChatGlassOpacity(Number.NaN)).toBe(DEFAULT_NATIVE_CHAT_GLASS_OPACITY)
    expect(normalizeNativeChatGlassOpacity(undefined)).toBe(DEFAULT_NATIVE_CHAT_GLASS_OPACITY)
  })

  it('clamps interface glass opacity with its own fallback', () => {
    expect(normalizeInterfaceGlassOpacity(0.5)).toBe(0.5)
    expect(normalizeInterfaceGlassOpacity(0.1)).toBe(MIN_GLASS_OPACITY)
    expect(normalizeInterfaceGlassOpacity('0.5')).toBe(DEFAULT_INTERFACE_GLASS_OPACITY)
  })
})
