import { describe, expect, it } from 'vitest'
import {
  describePluginContributions,
  EMPTY_CONTRIBUTION_SOURCE,
  nameFromContributionPath,
  uncoveredCatalogTypes
} from './plugin-contributions'

describe('plugin contributions', () => {
  it('names each contribution with what kind it is', () => {
    const rows = describePluginContributions({
      ...EMPTY_CONTRIBUTION_SOURCE,
      appThemes: [{ id: 'midnight', label: 'Midnight', base: 'dark' }],
      iconThemes: [{ id: 'minimal', label: 'Minimal Icons' }],
      syntaxes: [
        {
          id: 'gleam',
          label: 'Gleam',
          extensions: ['.gleam', '.glm', '.a', '.b', '.c'],
          filenames: []
        }
      ],
      recipes: ['Ubuntu dev']
    })
    expect(rows.map((row) => [row.title, row.detail])).toEqual([
      ['Midnight', 'App theme · Dark'],
      ['Minimal Icons', 'File icon theme'],
      ['Gleam', 'Syntax highlighting · .gleam, .glm, .a, .b +1'],
      ['Ubuntu dev', 'Machine recipe']
    ])
  })

  it('says when a grammar failed instead of listing its files', () => {
    const [row] = describePluginContributions({
      ...EMPTY_CONTRIBUTION_SOURCE,
      syntaxes: [
        { id: 'gleam', label: 'Gleam', extensions: ['.gleam'], filenames: [], failed: true }
      ]
    })
    expect(row).toMatchObject({
      tone: 'destructive',
      detail: 'Highlighting stopped: this grammar failed.'
    })
  })

  it('warns when a language pack is too incomplete to choose', () => {
    const [complete, partial] = describePluginContributions({
      ...EMPTY_CONTRIBUTION_SOURCE,
      languages: [
        { locale: 'fr', coverage: 96 },
        { locale: 'de', coverage: 40 }
      ]
    })
    expect(complete).toMatchObject({
      tone: 'default',
      detail: 'Interface language · 96% translated'
    })
    expect(partial.tone).toBe('warning')
    expect(partial.detail).toContain('40%')
  })

  it('reads a recipe or agent name from its file path', () => {
    expect(nameFromContributionPath('recipes/ubuntu-dev.json')).toBe('Ubuntu dev')
    expect(nameFromContributionPath('agents/code_reviewer.json')).toBe('Code reviewer')
  })

  it('falls back to catalog types only for what nothing names', () => {
    const rows = describePluginContributions({
      ...EMPTY_CONTRIBUTION_SOURCE,
      appThemes: [{ id: 'midnight', label: 'Midnight' }]
    })
    expect(
      uncoveredCatalogTypes(['app-theme', 'terminal-theme', 'instructions', 'worker'], rows, true)
    ).toEqual(['terminal-theme'])
  })
})
