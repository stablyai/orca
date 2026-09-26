import { describe, expect, it } from 'vitest'
import { classifyTabEntryQuery, getTabEntryOptions } from './tab-create-entry-classifier'
import { prepareQuickOpenFiles } from '../quick-open-search'
import { findExistingFileMatches } from './tab-create-entry-file-matches'

const unrelatedFiles = [
  'tests/e2e/terminal-split-activation-latency-main-probe.ts',
  'src/main/linear/issue-context-inline-media.test.ts',
  'src/renderer/src/components/editor/combined-diff/resolve-changes/combined-diff-section-cache-match.ts'
]
const readyFiles = (files: string[]) => ({ files, loading: false, loadError: null })

describe('new-tab file matches versus web search', () => {
  it('puts search ahead of scattered path matches for asciinema', () => {
    const options = getTabEntryOptions('asciinema', readyFiles(unrelatedFiles))
    expect(options.map((option) => option.classification.kind)).toEqual([
      'search',
      'existing-file',
      'existing-file',
      'existing-file'
    ])
    expect(classifyTabEntryQuery('asciinema', readyFiles(unrelatedFiles))).toEqual({
      kind: 'search',
      engine: 'google',
      query: 'asciinema'
    })
  })

  it('keeps an actual filename match ahead of search and weak matches below it', () => {
    const options = getTabEntryOptions(
      'asciinema',
      readyFiles([...unrelatedFiles, 'docs/asciinema-guide.md'])
    )
    expect(options[0].classification).toMatchObject({
      kind: 'existing-file',
      relativePath: 'docs/asciinema-guide.md'
    })
    expect(options[1].classification.kind).toBe('search')
    expect(options.slice(2).every((option) => option.classification.kind === 'existing-file')).toBe(
      true
    )
  })

  it.each([1, 2, 4, 8])('finds a literal filename before limiting to %i actions', (limit) => {
    const files = readyFiles([
      ...Array.from({ length: 10 }, (_, index) => `b/u/t/t/o/n/file-${index}.ts`),
      'src/components/Button.tsx'
    ])
    expect(getTabEntryOptions('button', files, limit)[0].classification).toMatchObject({
      kind: 'existing-file',
      relativePath: 'src/components/Button.tsx'
    })
  })

  it('offers fuzzy filename abbreviations below search', () => {
    expect(
      getTabEntryOptions('btn', readyFiles(['src/components/Button.tsx'])).map(
        (option) => option.classification
      )
    ).toEqual([
      { kind: 'search', engine: 'google', query: 'btn' },
      { kind: 'existing-file', matchKind: 'fuzzy', relativePath: 'src/components/Button.tsx' },
      { kind: 'new-file', relativePath: 'btn' }
    ])
  })

  it('finds literal filenames even when their old fuzzy score falls outside the result limit', () => {
    const target = `docs/a${'x'.repeat(120)}-asciinema.md`
    const files = readyFiles([
      ...Array.from({ length: 10 }, (_, index) => `a/s/c/i/i/n/e/m/a/file-${index}.ts`),
      target
    ])
    expect(getTabEntryOptions('asciinema', files)[0].classification).toMatchObject({
      kind: 'existing-file',
      relativePath: target
    })
  })

  it.each([
    ['btn', 'src/components/Button.tsx', false],
    ['button', 'src/components/Button.tsx', true],
    ['asciinema', 'docs/ASCIINEMA-guide.md', true],
    ['asciinema', 'docs\\ASCIINEMA-guide.md', true],
    ['asciinema', `docs/a${'x'.repeat(120)}-asciinema.md`, true],
    ['asciinema', unrelatedFiles[0], false],
    ['asciinema', unrelatedFiles[1], false],
    ['asciinema', unrelatedFiles[2], false],
    ['abc', 'alphabet-biology-chemistry.md', false],
    ['abc', 'a----b----c.md', false],
    ['btn', 'src/base/tone.ts', false]
  ])('reports literal filename matching for %s in %s', (query, path, matches) => {
    const results = findExistingFileMatches(query, prepareQuickOpenFiles([path]), 1)
    expect(results.some((result) => result.matchKind === 'literal-basename')).toBe(matches)
  })

  it.each(['a', 'AB', 'é', 'e\u0301', '12'])('puts search first for short token %s', (query) => {
    const files = readyFiles(
      Array.from({ length: 10 }, (_, index) => `docs/${query}-guide-${index}.md`)
    )
    for (const limit of [1, 2, 4, 8]) {
      const options = getTabEntryOptions(query, files, limit)
      expect(options[0].classification).toEqual({ kind: 'search', engine: 'google', query })
      expect(options.slice(1).map((option) => option.classification)).toEqual(
        Array.from({ length: limit - 1 }, (_, index) => ({
          kind: 'existing-file',
          matchKind: 'literal-basename',
          relativePath: `docs/${query}-guide-${index}.md`
        }))
      )
    }
  })

  it.each(['a', 'ab'])('keeps exact short filename %s ahead of search', (query) => {
    for (const relativePath of [query, `docs/${query}`]) {
      const files = readyFiles([`${query}-guide.md`, relativePath])
      expect(classifyTabEntryQuery(query, files)).toEqual({
        kind: 'existing-file',
        matchKind: relativePath === query ? 'exact-path' : 'exact-basename',
        relativePath
      })
    }
  })

  it.each(['文', '工具'])('keeps short CJK filename matches ahead of search for %s', (query) => {
    expect(classifyTabEntryQuery(query, readyFiles([`docs/${query}指南.md`]))).toEqual({
      kind: 'existing-file',
      matchKind: 'literal-basename',
      relativePath: `docs/${query}指南.md`
    })
  })

  it('reserves search when literal filenames fill the list', () => {
    const files = readyFiles(['button.tsx', 'button.css', 'button.test.ts', 'button.md'])
    expect(getTabEntryOptions('button', files).map((option) => option.classification.kind)).toEqual(
      ['existing-file', 'existing-file', 'existing-file', 'search']
    )
    expect(classifyTabEntryQuery('button', files).kind).toBe('existing-file')
  })
})
