import { describe, expect, it } from 'vitest'
import {
  describePluginContributions,
  EMPTY_CONTRIBUTION_SOURCE,
  uncoveredCatalogTypes
} from './plugin-contributions'

describe('plugin contributions', () => {
  it('names each contribution with what kind it is', () => {
    const rows = describePluginContributions({
      ...EMPTY_CONTRIBUTION_SOURCE,
      themes: [{ id: 'midnight', label: 'Midnight', base: 'dark' }],
      iconThemes: [{ id: 'minimal', label: 'Minimal Icons' }],
      syntaxes: [
        {
          id: 'gleam',
          label: 'Gleam',
          extensions: ['.gleam', '.glm', '.a', '.b', '.c'],
          filenames: []
        }
      ],
      vmRecipes: ['Ubuntu dev']
    })
    expect(rows.map((row) => [row.title, row.detail])).toEqual([
      ['Midnight', 'App theme · Dark'],
      ['Minimal Icons', 'File icon theme'],
      ['Gleam', 'Syntax highlighting · .gleam, .glm, .a, .b +1'],
      ['Ubuntu dev', 'Machine recipe']
    ])
  })

  it('falls back to catalog types only for what nothing names', () => {
    const rows = describePluginContributions({
      ...EMPTY_CONTRIBUTION_SOURCE,
      themes: [{ id: 'midnight', label: 'Midnight' }]
    })
    expect(
      uncoveredCatalogTypes(['app-theme', 'terminal-theme', 'instructions', 'worker'], rows, true)
    ).toEqual(['terminal-theme'])
  })
})
