import { describe, expect, it } from 'vitest'
import { safePluginThemeTokens, type ColorProbe, type Rgba } from './plugin-theme-tokens'

const colors: Record<string, Rgba> = {
  '#000000': [0, 0, 0, 1],
  '#ffffff': [255, 255, 255, 1],
  '#1a1a1a': [26, 26, 26, 1],
  'rgb(255 255 255 / 0.1)': [255, 255, 255, 0.1]
}
const probe: ColorProbe = (value) => colors[value] ?? null

describe('selected host badge border contrast', () => {
  it('keeps a visible border on a translucent selected surface', () => {
    expect(
      safePluginThemeTokens(
        {
          '--worktree-sidebar': '#000000',
          '--worktree-sidebar-foreground': '#ffffff',
          '--worktree-sidebar-active': 'rgb(255 255 255 / 0.1)',
          '--host-badge-border': '#ffffff'
        },
        'dark',
        {},
        probe
      )
    ).toEqual({
      '--worktree-sidebar': '#000000',
      '--worktree-sidebar-foreground': '#ffffff',
      '--worktree-sidebar-active': 'rgb(255 255 255 / 0.1)',
      '--host-badge-border': '#ffffff'
    })
  })

  it('drops only a border that disappears into the composited selected surface', () => {
    expect(
      safePluginThemeTokens(
        {
          '--worktree-sidebar': '#000000',
          '--worktree-sidebar-foreground': '#ffffff',
          '--worktree-sidebar-active': 'rgb(255 255 255 / 0.1)',
          '--host-badge-border': '#1a1a1a'
        },
        'dark',
        {},
        probe
      )
    ).toEqual({
      '--worktree-sidebar': '#000000',
      '--worktree-sidebar-foreground': '#ffffff',
      '--worktree-sidebar-active': 'rgb(255 255 255 / 0.1)'
    })
  })

  it('checks a border against the default selected wash when active is omitted', () => {
    expect(
      safePluginThemeTokens(
        {
          '--worktree-sidebar': '#000000',
          '--worktree-sidebar-foreground': '#ffffff',
          '--host-badge-border': '#1a1a1a'
        },
        'dark',
        {},
        probe
      )
    ).toEqual({
      '--worktree-sidebar': '#000000',
      '--worktree-sidebar-foreground': '#ffffff'
    })
  })
})
