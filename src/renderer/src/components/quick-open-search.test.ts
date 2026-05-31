import { describe, expect, it } from 'vitest'
import {
  QUICK_OPEN_RESULT_LIMIT,
  prepareQuickOpenFiles,
  rankQuickOpenFiles
} from './quick-open-search'

describe('quick-open-search', () => {
  it('returns the first 50 paths with score 0 for an empty query', () => {
    const files = Array.from({ length: 75 }, (_, index) => `src/file-${index}.ts`)

    expect(rankQuickOpenFiles('', prepareQuickOpenFiles(files))).toEqual(
      files.slice(0, QUICK_OPEN_RESULT_LIMIT).map((path) => ({ path, score: 0 }))
    )
  })

  it('treats a whitespace-only query as empty', () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts']

    expect(rankQuickOpenFiles('   ', prepareQuickOpenFiles(files))).toEqual([
      { path: 'src/a.ts', score: 0 },
      { path: 'src/b.ts', score: 0 },
      { path: 'src/c.ts', score: 0 }
    ])
  })

  it('prefers filename substring matches over path-only matches', () => {
    const files = ['button-area/deep/path/file.tsx', 'src/components/Button.tsx']

    expect(
      rankQuickOpenFiles('button', prepareQuickOpenFiles(files)).map((item) => item.path)
    ).toEqual(['src/components/Button.tsx', 'button-area/deep/path/file.tsx'])
  })

  it('keeps first-seen order for tie-heavy results at the limit boundary', () => {
    const files = Array.from({ length: 10 }, (_, index) => `src/path-${index}.bin`)

    expect(rankQuickOpenFiles('s', prepareQuickOpenFiles(files), 4)).toEqual([
      { path: 'src/path-0.bin', score: 0 },
      { path: 'src/path-1.bin', score: 0 },
      { path: 'src/path-2.bin', score: 0 },
      { path: 'src/path-3.bin', score: 0 }
    ])
  })

  it('returns 50 top-ranked results from a 100k synthetic list', () => {
    const fillerCount = 99_940
    const topCandidateCount = 60
    const files = [
      ...Array.from(
        { length: fillerCount },
        (_, index) => `n-x-e-x-e-x-d-x-l-x-e/group-${index}/file.ts`
      ),
      ...Array.from({ length: topCandidateCount }, (_, index) => `bulk/special-${index}/needle.ts`)
    ]

    const results = rankQuickOpenFiles('needle', prepareQuickOpenFiles(files))

    expect(results).toHaveLength(QUICK_OPEN_RESULT_LIMIT)
    expect(results.map((item) => item.path)).toEqual(
      Array.from(
        { length: QUICK_OPEN_RESULT_LIMIT },
        (_, index) => `bulk/special-${index}/needle.ts`
      )
    )
  })

  it('returns scores sorted ascending', () => {
    const files = [
      'src/components/QuickOpen.tsx',
      'quick/open/deep/path/file.tsx',
      'src/q-u-i-c-k-open.ts'
    ]

    const scores = rankQuickOpenFiles('quick', prepareQuickOpenFiles(files)).map(
      (item) => item.score
    )

    expect(scores).toEqual([...scores].sort((a, b) => a - b))
  })

  it('indexes normalized relative paths without changing path semantics', () => {
    const files = [
      'src/renderer/src/components/QuickOpen.tsx',
      'packages/windows-origin/src/App.tsx',
      'single-file.ts',
      'legacy\\provider\\raw-path.ts'
    ]

    expect(prepareQuickOpenFiles(files)).toEqual([
      {
        path: 'src/renderer/src/components/QuickOpen.tsx',
        lowerPath: 'src/renderer/src/components/quickopen.tsx',
        lowerFilename: 'quickopen.tsx',
        inputIndex: 0
      },
      {
        path: 'packages/windows-origin/src/App.tsx',
        lowerPath: 'packages/windows-origin/src/app.tsx',
        lowerFilename: 'app.tsx',
        inputIndex: 1
      },
      {
        path: 'single-file.ts',
        lowerPath: 'single-file.ts',
        lowerFilename: 'single-file.ts',
        inputIndex: 2
      },
      {
        path: 'legacy\\provider\\raw-path.ts',
        lowerPath: 'legacy/provider/raw-path.ts',
        lowerFilename: 'raw-path.ts',
        inputIndex: 3
      }
    ])
  })

  it('returns no results for non-positive limits', () => {
    const files = prepareQuickOpenFiles(['src/a.ts'])

    expect(rankQuickOpenFiles('a', files, 0)).toEqual([])
    expect(rankQuickOpenFiles('a', files, -1)).toEqual([])
  })

  it('matches Windows-style path queries against slash-normalized file paths', () => {
    const files = prepareQuickOpenFiles([
      'src/components/Button.tsx',
      'src/components/ButtonGroup.tsx',
      'src/routes/About.tsx'
    ])

    expect(rankQuickOpenFiles('src\\components\\button', files).map((item) => item.path)).toEqual([
      'src/components/Button.tsx',
      'src/components/ButtonGroup.tsx'
    ])
  })
})
