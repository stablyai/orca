import { describe, expect, it } from 'vitest'
import { themeStudioWarnings } from './theme-studio-warnings'

const dark = {
  tokens: {
    '--background': '#101010',
    '--foreground': '#eeeeee',
    '--editor-surface': '#1a1a1a',
    '--diff-added': '#40c060',
    '--primary': '#4080ff'
  },
  terminal: {
    background: '#1c1c1c',
    foreground: '#eeeeee',
    black: '#000000',
    red: '#e05050',
    green: '#203020',
    blue: '#e0a040'
  }
}

describe('themeStudioWarnings', () => {
  const warnings = themeStudioWarnings({ name: 'x', dark, light: null })
  const ids = warnings.map((warning) => warning.id)

  it('flags dim ANSI colors except black on a dark terminal', () => {
    expect(ids).toContain('dark-ansi-floor-green')
    expect(ids).not.toContain('dark-ansi-floor-black')
    expect(ids).not.toContain('dark-ansi-floor-red')
  })

  it('flags an ANSI color that no longer reads as its name', () => {
    expect(ids).toContain('dark-ansi-hue-blue')
    expect(ids).not.toContain('dark-ansi-hue-red')
  })

  it('flags a near-miss seam between terminal and editor', () => {
    expect(ids).toContain('dark-surface-seam')
  })

  it('flags a light/dark pair whose accent changes hue', () => {
    const paired = themeStudioWarnings({
      name: 'x',
      dark,
      light: { tokens: { ...dark.tokens, '--primary': '#e06020' } }
    })
    expect(paired.map((warning) => warning.id)).toContain('pair-hue-primary')
  })

  it('says nothing without a draft', () => {
    expect(themeStudioWarnings(null)).toEqual([])
  })
})
