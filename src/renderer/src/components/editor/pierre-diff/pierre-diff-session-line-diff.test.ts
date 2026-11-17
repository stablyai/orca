import { DiffHunksRenderer, setLineDiffProvider, type FileDiffMetadata } from '@pierre/diffs'
import { TextDocument } from '@pierre/diffs/edit'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computePierreLineChanges } from './pierre-diff-line-changes'
import { formatPierreLinePatch } from './pierre-diff-line-patch'
import { buildPierreFileDiff } from './pierre-diff-metadata'

const original = Array.from({ length: 13_200 }, (_, index) => `line ${index}\n`)
const modified = original.map((line, index) => (index % 12 === 0 ? `changed ${index}\n` : line))
const computeAsync = vi.fn(async (oldLines: readonly string[], newLines: readonly string[]) =>
  computePierreLineChanges(oldLines, newLines, false)
)

beforeEach(() => {
  setLineDiffProvider({
    syncLineLimit: 500,
    computeSync: (oldLines, newLines) => computePierreLineChanges(oldLines, newLines, false),
    computeAsync,
    formatPatch: formatPierreLinePatch
  })
})
afterEach(() => {
  setLineDiffProvider(undefined)
  computeAsync.mockClear()
})

function startSession() {
  const diff = buildPierreFileDiff({
    path: 'file.ts',
    status: 'modified',
    originalContent: original.join(''),
    modifiedContent: modified.join(''),
    parseDiffOptions: {}
  })
  const session: FileDiffMetadata = { ...diff, additionLines: [...diff.additionLines] }
  delete session.cacheKey
  const renderer = new DiffHunksRenderer({})
  renderer.beginEditSession(session)
  const edit = (lines: string[]) =>
    renderer.applyDocumentChange(new TextDocument('file.ts', lines.join(''), 'typescript'))
  return { session, renderer, edit }
}

const changeBlocks = (diff: FileDiffMetadata) =>
  diff.hunks.flatMap((hunk) => hunk.hunkContent.filter((content) => content.type === 'change'))

it('keeps every separated hunk exact after typing on a context line of a large diff', () => {
  const { session, edit } = startSession()
  expect(changeBlocks(session)).toHaveLength(1_100)
  const lines = [...modified]
  lines.splice(6_006, 0, 'typed\n')
  edit(lines)
  const blocks = changeBlocks(session)
  expect(blocks).toHaveLength(1_101)
  expect(blocks[501]).toMatchObject({ additions: 1, deletions: 0, additionLineIndex: 6_006 })
  expect(blocks[502]).toMatchObject({ additions: 1, deletions: 1, additionLineIndex: 6_013 })
  expect(computeAsync).not.toHaveBeenCalled()
})

it('defers a large edited region to the async diff, then installs its exact hunks', async () => {
  const { session, renderer, edit } = startSession()
  const resolved = new Promise<void>((resolve) => {
    renderer.onLineDiffResolved = resolve
  })
  edit(
    modified.map((line, index) =>
      index >= 100 && index < 700 && index % 50 === 7 ? 'pasted\n' : line
    )
  )
  const pending = changeBlocks(session)
  expect(pending).toHaveLength(1_055)
  expect(pending[9]).toEqual({
    type: 'change',
    additions: 551,
    deletions: 551,
    additionLineIndex: 107,
    deletionLineIndex: 107,
    deferredLineDiff: true
  })
  await resolved
  const blocks = changeBlocks(session)
  expect(computeAsync).toHaveBeenCalledTimes(1)
  expect(blocks).toHaveLength(1_108)
  expect(blocks[9]).toEqual({
    type: 'change',
    additions: 2,
    deletions: 2,
    additionLineIndex: 107,
    deletionLineIndex: 107
  })
  expect(blocks.some((block) => 'deferredLineDiff' in block)).toBe(false)
})
