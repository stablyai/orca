import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { resolveLeftSidebarStyleVariables } from './left-sidebar-appearance'

function settings(overrides = {}) {
  return {
    ...getDefaultSettings(tmpdir()),
    ...overrides
  }
}

describe('resolveLeftSidebarStyleVariables', () => {
  it('leaves the default sidebar token surface untouched', () => {
    expect(resolveLeftSidebarStyleVariables(settings(), true)).toBeUndefined()
  })

  it('returns only active-workspace contrast variables for default sidebar contrast changes', () => {
    const vars = resolveLeftSidebarStyleVariables(settings({ activeWorkspaceContrast: 3 }), true)

    expect(vars).toEqual({
      '--worktree-card-active-bg-mix': '26%',
      '--worktree-card-active-dark-bg-mix': '19%',
      '--worktree-card-active-border-mix': '78%'
    })
  })

  it('returns the mid-step active-workspace contrast variables', () => {
    const vars = resolveLeftSidebarStyleVariables(settings({ activeWorkspaceContrast: 2 }), true)

    expect(vars).toEqual({
      '--worktree-card-active-bg-mix': '18%',
      '--worktree-card-active-dark-bg-mix': '15%',
      '--worktree-card-active-border-mix': '60%'
    })
  })

  it('merges active-workspace contrast variables into matched terminal surfaces', () => {
    const vars = resolveLeftSidebarStyleVariables(
      settings({
        leftSidebarAppearanceMode: 'match-terminal',
        activeWorkspaceContrast: 2,
        terminalColorOverrides: {
          background: '#101820',
          foreground: '#f0f4f8'
        }
      }),
      true
    )

    expect(vars).toMatchObject({
      '--worktree-sidebar': '#101820',
      '--sidebar-foreground': '#f0f4f8',
      '--worktree-card-active-bg-mix': '18%',
      '--worktree-card-active-dark-bg-mix': '15%',
      '--worktree-card-active-border-mix': '60%'
    })
  })

  it('merges active-workspace contrast variables into tinted surfaces', () => {
    const vars = resolveLeftSidebarStyleVariables(
      settings({
        leftSidebarAppearanceMode: 'tinted',
        activeWorkspaceContrast: 3,
        leftSidebarTintColor: '336699',
        leftSidebarTintOpacity: 0.125
      }),
      true
    )

    expect(vars).toMatchObject({
      '--worktree-sidebar': 'color-mix(in srgb, #336699 12.5%, var(--background))',
      '--worktree-card-active-bg-mix': '26%',
      '--worktree-card-active-dark-bg-mix': '19%',
      '--worktree-card-active-border-mix': '78%'
    })
  })

  it('clamps out-of-range active-workspace contrast before resolving variables', () => {
    const highVars = resolveLeftSidebarStyleVariables(
      settings({ activeWorkspaceContrast: 99 }),
      true
    )
    const lowVars = resolveLeftSidebarStyleVariables(settings({ activeWorkspaceContrast: 0 }), true)

    expect(highVars).toEqual({
      '--worktree-card-active-bg-mix': '26%',
      '--worktree-card-active-dark-bg-mix': '19%',
      '--worktree-card-active-border-mix': '78%'
    })
    expect(lowVars).toBeUndefined()
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
