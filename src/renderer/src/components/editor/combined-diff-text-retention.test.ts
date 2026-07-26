import { describe, expect, it } from 'vitest'
import { MAX_RENDERED_DIFF_COMBINED_CHARACTERS } from '../../../../shared/large-diff-render-limit'
import type { DiffSection } from './diff-section-types'
import {
  COMBINED_DIFF_VIEW_STATE_CACHE_MAX_ENTRIES,
  MAX_RETAINED_COMBINED_DIFF_TEXT_BYTES,
  MAX_RETAINED_COMBINED_DIFF_TEXT_CHARACTERS,
  getCombinedDiffViewedSectionKeys,
  inspectCombinedDiffTextRetention,
  retainCombinedDiffSectionText,
  retainCombinedDiffViewStateText
} from './combined-diff-text-retention'

function textSection(key: string, content: string): DiffSection {
  return {
    key,
    path: `${key}.ts`,
    status: 'modified',
    originalContent: content,
    modifiedContent: '',
    collapsed: false,
    loading: false,
    dirty: false,
    diffResult: {
      kind: 'text',
      originalContent: content,
      modifiedContent: '',
      originalIsBinary: false,
      modifiedIsBinary: false
    },
    largeDiffRenderLimit: null
  }
}

describe('combined diff text retention', () => {
  it('bounds many individually renderable files by evicting the oldest offscreen bodies', () => {
    const justUnderPerFileLimit = 'x'.repeat(MAX_RENDERED_DIFF_COMBINED_CHARACTERS - 1)
    const sections = Array.from({ length: 10 }, (_, index) =>
      textSection(`section-${index}`, justUnderPerFileLimit)
    )
    const loadedIndices = sections.map((_, index) => index)

    const result = retainCombinedDiffSectionText({
      sections,
      loadedIndices,
      protectedSectionKeys: new Set(['section-9'])
    })

    const inspection = inspectCombinedDiffTextRetention(result.sections)
    expect(inspection.characters).toBeLessThanOrEqual(MAX_RETAINED_COMBINED_DIFF_TEXT_CHARACTERS)
    expect(inspection.approximateBytes).toBeLessThanOrEqual(MAX_RETAINED_COMBINED_DIFF_TEXT_BYTES)
    expect(result.evictedIndices[0]).toBe(0)
    expect(result.sections[9].originalContent).toBe(justUnderPerFileLimit)
    expect(result.loadedIndices).not.toContain(result.evictedIndices[0])
    for (const index of result.evictedIndices) {
      expect(result.sections[index]).toMatchObject({
        originalContent: '',
        modifiedContent: '',
        loading: true,
        diffResult: null
      })
    }
  })

  it('makes an evicted section reloadable and retains its refetched body when revisited', () => {
    const firstPass = retainCombinedDiffSectionText({
      sections: [textSection('old', '12345678'), textSection('active', 'abcdefgh')],
      loadedIndices: [0, 1],
      protectedSectionKeys: new Set(['active']),
      maxCharacters: 10
    })

    expect(firstPass.evictedIndices).toEqual([0])
    expect(firstPass.loadedIndices).toEqual([1])
    expect(getCombinedDiffViewedSectionKeys(firstPass.sections)).toEqual(new Set(['old', 'active']))

    const refetched = firstPass.sections.map((section, index) =>
      index === 0 ? textSection('old', 'refetched') : section
    )
    const secondPass = retainCombinedDiffSectionText({
      sections: refetched,
      loadedIndices: [...firstPass.loadedIndices, 0],
      protectedSectionKeys: new Set(['old']),
      maxCharacters: 10
    })

    expect(secondPass.sections[0].originalContent).toBe('refetched')
    expect(secondPass.loadedIndices).toContain(0)
    expect(secondPass.evictedIndices).toEqual([1])
  })

  it('keeps the full view-state LRU within one aggregate text budget', () => {
    const body = 'x'.repeat(Math.floor(MAX_RETAINED_COMBINED_DIFF_TEXT_CHARACTERS / 2))
    const viewStates = new Map(
      Array.from({ length: COMBINED_DIFF_VIEW_STATE_CACHE_MAX_ENTRIES }, (_, index) => [
        `view-${index}`,
        { sections: [textSection(`section-${index}`, body)], loadedIndices: [0] }
      ])
    )

    const inspection = retainCombinedDiffViewStateText(viewStates)

    expect(inspection.characters).toBeLessThanOrEqual(MAX_RETAINED_COMBINED_DIFF_TEXT_CHARACTERS)
    expect(viewStates.get('view-0')?.sections[0].originalContent).toBe('')
    expect(viewStates.get('view-19')?.sections[0].originalContent).toBe(body)
  })

  it('never evicts active, loading, or unsaved section text', () => {
    const dirty = { ...textSection('dirty', 'dirty text'), dirty: true }
    const loading = { ...textSection('loading', 'loading text'), loading: true }
    const result = retainCombinedDiffSectionText({
      sections: [
        textSection('old', 'old text'),
        dirty,
        loading,
        textSection('active', 'active text')
      ],
      loadedIndices: [0, 1, 2, 3],
      protectedSectionKeys: new Set(['active']),
      maxCharacters: 0
    })

    expect(result.evictedIndices).toEqual([0])
    expect(result.sections[1].originalContent).toBe('dirty text')
    expect(result.sections[2].originalContent).toBe('loading text')
    expect(result.sections[3].originalContent).toBe('active text')
  })
})
