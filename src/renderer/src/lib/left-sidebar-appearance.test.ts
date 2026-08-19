import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import {
  APP_APPEARANCE_STYLE_PROPERTIES,
  resolveAppAppearanceDarkMode,
  resolveLeftSidebarStyleVariables
} from './left-sidebar-appearance'

function settings(overrides = {}) {
  return {
    ...getDefaultSettings(tmpdir()),
    ...overrides
  }
}

describe('resolveLeftSidebarStyleVariables', () => {
  it('leaves the default app surface untouched', () => {
    expect(resolveLeftSidebarStyleVariables(settings(), true)).toBeUndefined()
  })

  it('derives the complete app surface token family from the terminal', () => {
    const vars = resolveLeftSidebarStyleVariables(
      settings({
        leftSidebarAppearanceMode: 'match-terminal',
        terminalColorOverrides: {
          background: '#101820',
          foreground: '#f0f4f8'
        }
      }),
      true
    )

    expect(Object.keys(vars ?? {}).sort()).toEqual([...APP_APPEARANCE_STYLE_PROPERTIES].sort())
    expect(vars).toMatchObject({
      '--background': '#101820',
      '--foreground': '#f0f4f8',
      '--card-foreground': '#f0f4f8',
      '--popover-foreground': '#f0f4f8',
      '--primary': '#f0f4f8',
      '--primary-foreground': '#101820',
      '--secondary-foreground': '#f0f4f8',
      '--worktree-sidebar': '#101820',
      '--worktree-sidebar-primary': '#f0f4f8',
      '--worktree-sidebar-primary-foreground': '#101820',
      '--sidebar': '#101820',
      '--sidebar-primary': '#f0f4f8',
      '--sidebar-primary-foreground': '#101820'
    })
    expect(vars?.['--input']).toContain('#f0f4f8 15%')
    expect(vars?.['--ring']).toContain('#f0f4f8 44%')
    expect(vars?.['--bg-titlebar']).toBe(vars?.['--card'])
  })

  it('classifies App Appearance from terminal luminance instead of app preference', () => {
    expect(
      resolveAppAppearanceDarkMode(
        settings({
          theme: 'dark',
          leftSidebarAppearanceMode: 'match-terminal',
          terminalColorOverrides: { background: '#ffffff' }
        }),
        true
      )
    ).toBe(false)
    expect(
      resolveAppAppearanceDarkMode(
        settings({
          theme: 'light',
          leftSidebarAppearanceMode: 'match-terminal',
          terminalColorOverrides: { background: '#101820' }
        }),
        false
      )
    ).toBe(true)
    expect(resolveAppAppearanceDarkMode(settings(), true)).toBeUndefined()
  })

  it('honors terminal background opacity for matched terminal surfaces', () => {
    const vars = resolveLeftSidebarStyleVariables(
      settings({
        leftSidebarAppearanceMode: 'match-terminal',
        terminalColorOverrides: { background: '#123456' },
        terminalBackgroundOpacity: 0.5
      }),
      true
    )

    expect(vars?.['--background']).toBe('rgba(18, 52, 86, 0.5)')
    expect(vars?.['--worktree-sidebar']).toBe('rgba(18, 52, 86, 0.5)')
  })

  it('builds tinted app surfaces from stable class-owned base tokens', () => {
    const vars = resolveLeftSidebarStyleVariables(
      settings({
        leftSidebarAppearanceMode: 'tinted',
        leftSidebarTintColor: '336699',
        leftSidebarTintOpacity: 0.125
      }),
      true
    )

    expect(vars?.['--background']).toBe(
      'color-mix(in srgb, #336699 12.5%, var(--app-appearance-base-background))'
    )
    expect(vars?.['--foreground']).toBe('var(--app-appearance-base-foreground)')
    expect(JSON.stringify(vars)).not.toContain('var(--background)')
    expect(JSON.stringify(vars)).not.toContain('var(--foreground)')
  })

  it('caps tinted opacity so arbitrary tint colors stay subtle', () => {
    const vars = resolveLeftSidebarStyleVariables(
      settings({
        leftSidebarAppearanceMode: 'tinted',
        leftSidebarTintColor: '#000000',
        leftSidebarTintOpacity: 1
      }),
      true
    )

    expect(vars?.['--background']).toBe(
      'color-mix(in srgb, #000000 35%, var(--app-appearance-base-background))'
    )
  })
})
