import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import {
  resolveLeftSidebarStyleVariables,
  resolveWorkspaceShellStyleVariables
} from './left-sidebar-appearance'

function settings(overrides = {}) {
  return {
    ...getDefaultSettings(tmpdir()),
    ...overrides
  }
}

describe('resolveLeftSidebarStyleVariables', () => {
  it('matches terminal surfaces by default', () => {
    const vars = resolveLeftSidebarStyleVariables(
      settings({
        terminalColorOverrides: {
          background: '#101820',
          foreground: '#f0f4f8'
        }
      }),
      true
    )

    expect(vars).toMatchObject({
      '--worktree-sidebar': '#101820',
      '--worktree-sidebar-foreground': '#f0f4f8',
      '--background': '#101820',
      '--foreground': '#f0f4f8'
    })
  })

  it('leaves explicit default sidebar token surfaces untouched', () => {
    expect(
      resolveLeftSidebarStyleVariables(settings({ leftSidebarAppearanceMode: 'default' }), true)
    ).toBeUndefined()
  })

  it('matches terminal background, foreground, and scoped text tokens', () => {
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

    expect(vars).toMatchObject({
      '--worktree-sidebar': '#101820',
      '--worktree-sidebar-foreground': '#f0f4f8',
      '--sidebar': '#101820',
      '--sidebar-foreground': '#f0f4f8',
      '--background': '#101820',
      '--foreground': '#f0f4f8'
    })
    expect(vars?.['--worktree-sidebar-accent']).toContain('#f0f4f8 9%')
    expect(vars?.['--sidebar-accent']).toBe(vars?.['--worktree-sidebar-accent'])
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

    expect(vars?.['--worktree-sidebar']).toBe('rgba(18, 52, 86, 0.5)')
  })

  it('builds a tinted surface from normalized tint settings', () => {
    const vars = resolveLeftSidebarStyleVariables(
      settings({
        leftSidebarAppearanceMode: 'tinted',
        leftSidebarTintColor: '336699',
        leftSidebarTintOpacity: 0.125
      }),
      true
    )

    expect(vars?.['--worktree-sidebar']).toBe(
      'color-mix(in srgb, #336699 12.5%, var(--background))'
    )
    expect(vars?.['--sidebar']).toBe(vars?.['--worktree-sidebar'])
    expect(vars?.['--worktree-sidebar-foreground']).toBe('var(--foreground)')
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

    expect(vars?.['--worktree-sidebar']).toBe('color-mix(in srgb, #000000 35%, var(--background))')
  })
})

describe('resolveWorkspaceShellStyleVariables', () => {
  it('matches the terminal palette for workspace shell surfaces by default', () => {
    const vars = resolveWorkspaceShellStyleVariables(
      settings({
        terminalColorOverrides: {
          background: '#101820',
          foreground: '#f0f4f8'
        }
      }),
      true
    )

    expect(vars).toMatchObject({
      '--background': '#101820',
      '--foreground': '#f0f4f8',
      '--card': 'color-mix(in srgb, #f0f4f8 4%, #101820)',
      '--border': 'color-mix(in srgb, #f0f4f8 7%, #101820)'
    })
  })

  it('does not theme the whole shell for explicit app-default or tinted sidebar modes', () => {
    expect(
      resolveWorkspaceShellStyleVariables(settings({ leftSidebarAppearanceMode: 'default' }), true)
    ).toBeUndefined()
    expect(
      resolveWorkspaceShellStyleVariables(settings({ leftSidebarAppearanceMode: 'tinted' }), true)
    ).toBeUndefined()
  })
})
