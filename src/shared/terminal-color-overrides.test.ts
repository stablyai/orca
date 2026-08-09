import { describe, expect, it } from 'vitest'

import {
  hasPerModeTerminalColorOverrides,
  mergeImportedTerminalColorOverrides,
  resetTerminalColorOverridesForMode,
  resolveTerminalColorOverridesForMode,
  updateTerminalColorOverrideKey
} from './terminal-color-overrides'
import type { GlobalSettings } from './types'

function settings(
  partial: Partial<
    Pick<
      GlobalSettings,
      | 'terminalColorOverrides'
      | 'terminalColorOverridesDark'
      | 'terminalColorOverridesLight'
      | 'terminalUseSeparateLightTheme'
    >
  > = {}
): Pick<
  GlobalSettings,
  | 'terminalColorOverrides'
  | 'terminalColorOverridesDark'
  | 'terminalColorOverridesLight'
  | 'terminalUseSeparateLightTheme'
> {
  return {
    terminalUseSeparateLightTheme: true,
    ...partial
  }
}

describe('resolveTerminalColorOverridesForMode', () => {
  it('uses the legacy bag for both modes before any per-mode edit', () => {
    const s = settings({ terminalColorOverrides: { background: '#111111' } })
    expect(resolveTerminalColorOverridesForMode(s, 'dark')?.background).toBe('#111111')
    expect(resolveTerminalColorOverridesForMode(s, 'light')?.background).toBe('#111111')
  })

  it('stops applying dark overrides to light after a dark-only edit', () => {
    const s = settings({
      terminalColorOverridesDark: { background: '#0a0a0a' },
      terminalColorOverridesLight: undefined
    })
    expect(resolveTerminalColorOverridesForMode(s, 'dark')?.background).toBe('#0a0a0a')
    expect(resolveTerminalColorOverridesForMode(s, 'light')).toBeUndefined()
  })

  it('reuses dark overrides in light when light matches dark mode', () => {
    const s = settings({
      terminalUseSeparateLightTheme: false,
      terminalColorOverridesDark: { background: '#0a0a0a' }
    })
    expect(resolveTerminalColorOverridesForMode(s, 'light')?.background).toBe('#0a0a0a')
  })
})

describe('updateTerminalColorOverrideKey', () => {
  it('promotes the first dark edit into a dark-only bag so light is no longer covered', () => {
    const before = settings({ terminalColorOverrides: { background: '#111111', red: '#ff0000' } })
    const updates = updateTerminalColorOverrideKey(before, 'dark', 'background', '#0a0a0a')
    expect(updates.terminalColorOverrides).toBeUndefined()
    expect(updates.terminalColorOverridesDark).toEqual({
      background: '#0a0a0a',
      red: '#ff0000'
    })
    expect(updates.terminalColorOverridesLight).toBeUndefined()
    expect(resolveTerminalColorOverridesForMode({ ...before, ...updates }, 'light')).toBeUndefined()
  })

  it('updates only the light bag on subsequent light edits', () => {
    const before = settings({
      terminalColorOverridesDark: { background: '#0a0a0a' },
      terminalColorOverridesLight: { background: '#ffffff' }
    })
    const updates = updateTerminalColorOverrideKey(before, 'light', 'foreground', '#111111')
    expect(updates).toEqual({
      terminalColorOverridesLight: { background: '#ffffff', foreground: '#111111' }
    })
  })

  it('writes the dark bag when light matches dark so overrides do not disappear', () => {
    const before = settings({
      terminalUseSeparateLightTheme: false,
      terminalColorOverrides: { background: '#111111' }
    })
    const updates = updateTerminalColorOverrideKey(before, 'light', 'background', '#0a0a0a')
    expect(updates.terminalColorOverrides).toBeUndefined()
    expect(updates.terminalColorOverridesDark).toEqual({ background: '#0a0a0a' })
    expect(updates.terminalColorOverridesLight).toBeUndefined()
    expect(
      resolveTerminalColorOverridesForMode({ ...before, ...updates }, 'light')?.background
    ).toBe('#0a0a0a')
  })
})

describe('resetTerminalColorOverridesForMode', () => {
  it('clears only the requested mode after dual-mode storage exists', () => {
    const before = settings({
      terminalColorOverridesDark: { background: '#0a0a0a' },
      terminalColorOverridesLight: { background: '#ffffff' }
    })
    expect(resetTerminalColorOverridesForMode(before, 'light')).toEqual({
      terminalColorOverridesLight: undefined
    })
  })

  it('splits a legacy bag so reset only clears the edited mode', () => {
    const before = settings({ terminalColorOverrides: { background: '#111111' } })
    const updates = resetTerminalColorOverridesForMode(before, 'dark')
    expect(updates.terminalColorOverrides).toBeUndefined()
    expect(updates.terminalColorOverridesDark).toBeUndefined()
    expect(updates.terminalColorOverridesLight).toEqual({ background: '#111111' })
  })

  it('clears the effective dark bag when light matches dark', () => {
    const before = settings({
      terminalUseSeparateLightTheme: false,
      terminalColorOverridesDark: { background: '#0a0a0a' },
      terminalColorOverridesLight: { background: '#ffffff' }
    })
    expect(resetTerminalColorOverridesForMode(before, 'light')).toEqual({
      terminalColorOverridesDark: undefined
    })
  })
})

describe('mergeImportedTerminalColorOverrides', () => {
  it('promotes the first import into a dark-only bag and clears legacy', () => {
    const before = settings({ terminalColorOverrides: { foreground: '#e0e0e0' } })
    const updates = mergeImportedTerminalColorOverrides(before, { background: '#1a1a1a' })
    expect(updates).toEqual({
      terminalColorOverrides: undefined,
      terminalColorOverridesDark: { foreground: '#e0e0e0', background: '#1a1a1a' }
    })
    expect(resolveTerminalColorOverridesForMode({ ...before, ...updates }, 'light')).toBeUndefined()
    expect(
      resolveTerminalColorOverridesForMode({ ...before, ...updates }, 'dark')?.background
    ).toBe('#1a1a1a')
  })

  it('merges into the existing dark bag when per-mode storage already exists', () => {
    const before = settings({
      terminalColorOverridesDark: { foreground: '#ccc' },
      terminalColorOverridesLight: { background: '#fff' }
    })
    expect(mergeImportedTerminalColorOverrides(before, { red: '#f00' })).toEqual({
      terminalColorOverridesDark: { foreground: '#ccc', red: '#f00' }
    })
  })
})

describe('hasPerModeTerminalColorOverrides', () => {
  it('is false for legacy-only settings', () => {
    expect(
      hasPerModeTerminalColorOverrides(settings({ terminalColorOverrides: { red: '#f00' } }))
    ).toBe(false)
  })

  it('is true once either mode bag exists', () => {
    expect(hasPerModeTerminalColorOverrides(settings({ terminalColorOverridesDark: {} }))).toBe(
      true
    )
  })
})
