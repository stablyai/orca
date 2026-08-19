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

  it('composites terminal opacity into opaque semantic colors', () => {
    const vars = resolveLeftSidebarStyleVariables(
      settings({
        leftSidebarAppearanceMode: 'match-terminal',
        terminalColorOverrides: { background: '#123456' },
        terminalBackgroundOpacity: 0.5
      }),
      true
    )
    const background = 'color-mix(in srgb, #123456 50%, var(--app-appearance-base-background))'

    expect(vars?.['--background']).toBe(background)
    expect(vars?.['--primary-foreground']).toBe(background)
    expect(vars?.['--worktree-sidebar']).toBe(background)
    expect(vars?.['--sidebar-primary-foreground']).toBe(background)
  })

  it('normalizes accepted overrides and falls back from incomplete colors', () => {
    const normalized = resolveLeftSidebarStyleVariables(
      settings({
        leftSidebarAppearanceMode: 'match-terminal',
        terminalColorOverrides: { background: '112233', foreground: '#' },
        terminalBackgroundOpacity: 0.5
      }),
      true
    )

    expect(normalized?.['--background']).toContain('#112233 50%')
    expect(normalized?.['--foreground']).toMatch(/^#[0-9a-f]{6}$/i)
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
