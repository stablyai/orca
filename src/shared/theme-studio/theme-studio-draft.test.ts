import { describe, expect, it } from 'vitest'
import {
  applyThemeStudioPatch,
  nearestThemeStudioKeys,
  type ThemeStudioDraft
} from './theme-studio-draft'
import { ThemeStudioError } from './theme-studio-errors'

const draft: ThemeStudioDraft = {
  name: 'Ember',
  light: { tokens: { '--background': '#ffffff', '--foreground': '#111111' } },
  dark: {
    tokens: { '--background': '#111111', '--foreground': '#eeeeee' },
    terminal: { background: '#111111', foreground: '#eeeeee', red: '#ff0000' }
  }
}

describe('applyThemeStudioPatch', () => {
  it('changes only the modes the patch names, accepting bare and dashed token names', () => {
    const { draft: next, changed } = applyThemeStudioPatch(draft, {
      dark: { set: { sidebar: '#222222', '--card': '#333333', 'terminal.red': '#ff5555' } }
    })
    expect(next.dark?.tokens['--sidebar']).toBe('#222222')
    expect(next.dark?.tokens['--card']).toBe('#333333')
    expect(next.dark?.terminal?.red).toBe('#ff5555')
    expect(next.light).toBe(draft.light)
    expect(draft.dark?.tokens['--sidebar']).toBeUndefined()
    expect(changed).toEqual({ light: [], dark: ['--sidebar', '--card', 'terminal.red'] })
  })

  it('refuses a typo with the intended token among the suggestions', () => {
    let error: unknown
    try {
      applyThemeStudioPatch(draft, { dark: { set: { 'sidebar-foregroud': '#ffffff' } } })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ThemeStudioError)
    expect(error instanceof ThemeStudioError && error.data.nearest).toContain(
      '--sidebar-foreground'
    )
  })

  it('refuses values that are not colors and removing a required token', () => {
    expect(() => applyThemeStudioPatch(draft, { dark: { set: { card: 'url(x)' } } })).toThrow(
      ThemeStudioError
    )
    expect(() =>
      applyThemeStudioPatch(draft, { dark: { set: { 'terminal.red': 'red' } } })
    ).toThrow(ThemeStudioError)
    expect(() => applyThemeStudioPatch(draft, { dark: { unset: ['background'] } })).toThrow(
      ThemeStudioError
    )
  })
})

it('suggests terminal keys for a terminal typo', () => {
  expect(nearestThemeStudioKeys('terminal.brightRad')[0]).toBe('terminal.brightRed')
})
