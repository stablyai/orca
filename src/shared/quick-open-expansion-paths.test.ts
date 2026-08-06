import { describe, expect, it } from 'vitest'
import { collapseQuickOpenExpansionPaths } from './quick-open-expansion-paths'

describe('collapseQuickOpenExpansionPaths', () => {
  it('collapses descendants without confusing shared-prefix siblings', () => {
    const paths = new Map<string, boolean>([
      ['foo/bar/deep', false],
      ['foo-sibling', false],
      ['foo', false],
      ['foo/bar', true]
    ])

    expect(collapseQuickOpenExpansionPaths(paths)).toEqual([
      ['foo', true],
      ['foo-sibling', false]
    ])
  })

  it('keeps many sibling placeholders distinct', () => {
    const paths = new Map(
      Array.from({ length: 10_001 }, (_, index) => [`generated-${index}`, true] as const)
    )

    expect(collapseQuickOpenExpansionPaths(paths)).toHaveLength(paths.size)
  })
})
