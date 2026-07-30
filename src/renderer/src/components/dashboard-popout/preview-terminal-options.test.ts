// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import {
  buildPreviewAppearanceOptions,
  buildPreviewTerminalOptions
} from './preview-terminal-options'

const SETTINGS = {
  terminalFontSize: 17,
  terminalFontFamily: 'Fira Code',
  terminalCursorStyle: 'bar',
  terminalCursorBlink: false,
  terminalLineHeight: 1.4,
  terminalWordSeparator: ' ()[]',
  terminalScrollSensitivity: 3
} as unknown as GlobalSettings

describe('buildPreviewAppearanceOptions', () => {
  it('carries the user terminal appearance a pane would apply', () => {
    const options = buildPreviewAppearanceOptions(SETTINGS, false)
    expect(options.fontSize).toBe(17)
    expect(options.fontFamily).toContain('Fira Code')
    expect(options.cursorStyle).toBe('bar')
    expect(options.cursorBlink).toBe(false)
    expect(options.lineHeight).toBe(1.4)
    expect(options.wordSeparator).toBe(' ()[]')
    expect(options.scrollSensitivity).toBe(3)
    // Why: a bar cursor's inactive style must not become xterm's block outline.
    expect(options.cursorInactiveStyle).toBe('bar')
  })

  it('enables macOptionIsMeta only for the resolved full Option-as-Alt', () => {
    expect(buildPreviewAppearanceOptions(SETTINGS, true).macOptionIsMeta).toBe(true)
    expect(buildPreviewAppearanceOptions(SETTINGS, false).macOptionIsMeta).toBe(false)
  })

  it('falls back to pane defaults with no settings hydrated', () => {
    const options = buildPreviewAppearanceOptions(null, false)
    expect(options.fontSize).toBe(14)
    expect(options.cursorBlink).toBe(true)
  })
})

describe('buildPreviewTerminalOptions', () => {
  const base = {
    settings: SETTINGS,
    macOptionIsMeta: false,
    theme: null,
    themeMode: 'dark' as const,
    cols: 100,
    rows: 30,
    scrollback: 1000
  }

  it('keeps the kitty advertisement and skips ConPTY options off Windows', () => {
    const options = buildPreviewTerminalOptions({
      ...base,
      terminalInput: {
        hostPlatform: 'darwin',
        localWindowsConpty: false,
        windowsShiftEnterEncoding: 'alt-enter',
        kittyKeyboardAdvertised: true
      }
    })
    expect(options.vtExtensions?.kittyKeyboard).toBe(true)
    expect(options.windowsPty).toBeUndefined()
    expect(options.cols).toBe(100)
  })

  it('mirrors the ConPTY backend and kitty withhold a local Windows pane resolves', () => {
    const options = buildPreviewTerminalOptions({
      ...base,
      terminalInput: {
        hostPlatform: 'win32',
        localWindowsConpty: true,
        osRelease: '10.0.22631',
        windowsShiftEnterEncoding: 'alt-enter',
        kittyKeyboardAdvertised: false
      }
    })
    expect(options.windowsPty).toEqual({ backend: 'conpty', buildNumber: 22631 })
    expect(options.vtExtensions?.kittyKeyboard).toBe(false)
  })

  it('keeps the advertised default when the card carries no host profile', () => {
    const options = buildPreviewTerminalOptions({ ...base, terminalInput: null })
    expect(options.vtExtensions?.kittyKeyboard).toBe(true)
    expect(options.windowsPty).toBeUndefined()
  })
})
