// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useCombinedDiffSectionIndexMap } from './use-combined-diff-section-index-map'

type Section = { key: string; loading: boolean }

function sectionsFor(keys: readonly string[], loadedKeys: readonly string[] = []): Section[] {
  return keys.map((key) => ({ key, loading: !loadedKeys.includes(key) }))
}

describe('useCombinedDiffSectionIndexMap', () => {
  const keys = ['combined-commit:a.ts', 'combined-commit:b.ts', 'combined-commit:c.ts']

  it('keeps the map identity across a section load that leaves the keys alone', () => {
    const { result, rerender } = renderHook(
      ({ sections }: { sections: Section[] }) =>
        useCombinedDiffSectionIndexMap({ entrySignature: 'pr-1', sections }),
      { initialProps: { sections: sectionsFor(keys) } }
    )
    const first = result.current

    // An on-demand load replaces the array and one section object; keys are untouched.
    rerender({ sections: sectionsFor(keys, ['combined-commit:b.ts']) })

    expect(result.current).toBe(first)
    expect([...result.current]).toEqual([
      ['combined-commit:a.ts', 0],
      ['combined-commit:b.ts', 1],
      ['combined-commit:c.ts', 2]
    ])
  })

  it('rebuilds when a section key changes in place', () => {
    const { result, rerender } = renderHook(
      ({ sections }: { sections: Section[] }) =>
        useCombinedDiffSectionIndexMap({ entrySignature: 'pr-1', sections }),
      { initialProps: { sections: sectionsFor(keys) } }
    )
    const first = result.current

    rerender({ sections: sectionsFor(['combined-commit:a.ts', 'combined-commit:renamed.ts']) })

    expect(result.current).not.toBe(first)
    expect(result.current.get('combined-commit:renamed.ts')).toBe(1)
    expect(result.current.has('combined-commit:b.ts')).toBe(false)
  })

  it('rebuilds when the entry set changes even if the keys happen to match', () => {
    const { result, rerender } = renderHook(
      ({ entrySignature }: { entrySignature: string }) =>
        useCombinedDiffSectionIndexMap({ entrySignature, sections: sectionsFor(keys) }),
      { initialProps: { entrySignature: 'pr-1' } }
    )
    const first = result.current

    rerender({ entrySignature: 'pr-2' })

    expect(result.current).not.toBe(first)
    expect([...result.current]).toEqual([...first])
  })
})
