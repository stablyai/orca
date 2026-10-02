import { describe, expect, it } from 'vitest'
import { createGitProgressRecordReader, type GitProgressRecord } from './git-progress-records'

// Captured through a Node execFile pipe from `git worktree add` of a 25-file repo with
// GIT_PROGRESS_DELAY=0, chunked exactly as the pipe delivered them.
const GIT_2_25_5_CHUNKS: string[] = [
  'Updating files:   4% (1/25)\rUpdating files:   8% (2/25)\rUpdating files:  12% (3/25)\r',
  'Updating files:  16% (4/25)\rUpdating files:  20% (5/25)\rUpdating files:  24% (6/25)\rUpdating files:  28% (7/25)\rUpdating files:  32% (8/25)\rUpdating files:  36% (9/25)\rUpdating files:  40% (10/25)\r',
  'Updating files:  44% (11/25)\r',
  'Updating files:  48% (12/25)\rUpdating files:  52% (13/25)\rUpdating files:  56% (14/25)\rUpdating files:  60% (15/25)\rUpdating files:  64% (16/25)\rUpdating files:  68% (17/25)\rUpdating files:  72% (18/25)\rUpdating files:  76% (19/25)\rUpdating files:  80% (20/25)\rUpdating files:  84% (21/25)\rUpdating files:  88% (22/25)\rUpdating files:  92% (23/25)\rUpdating files:  96% (24/25)\rUpdating files: 100% (25/25)\rUpdating files: 100% (25/25), done.\n'
]
const GIT_2_50_1_CHUNKS: string[] = [
  "Preparing worktree (new branch 'c250')\n",
  'Updating files:   4% (1/25)\r',
  'Updating files:   8% (2/25)\r',
  'Updating files:  12% (3/25)\r',
  'Updating files:  16% (4/25)\r',
  'Updating files:  20% (5/25)\r',
  'Updating files:  24% (6/25)\r',
  'Updating files:  28% (7/25)\r',
  'Updating files:  32% (8/25)\r',
  'Updating files:  36% (9/25)\r',
  'Updating files:  40% (10/25)\r',
  'Updating files:  44% (11/25)\r',
  'Updating files:  48% (12/25)\r',
  'Updating files:  52% (13/25)\r',
  'Updating files:  56% (14/25)\r',
  'Updating files:  60% (15/25)\r',
  'Updating files:  64% (16/25)\r',
  'Updating files:  68% (17/25)\r',
  'Updating files:  72% (18/25)\r',
  'Updating files:  76% (19/25)\r',
  'Updating files:  80% (20/25)\r',
  'Updating files:  84% (21/25)\r',
  'Updating files:  88% (22/25)\r',
  'Updating files:  92% (23/25)\r',
  'Updating files:  96% (24/25)\r',
  'Updating files: 100% (25/25)\rUpdating files: 100% (25/25), done.\n'
]
// Same capture with COLUMNS=20: git prints the title once, then bare counters.
const GIT_2_25_5_NARROW_CHUNKS: string[] = [
  'Updating files:     \n    4% (1/25)\r',
  '    8% (2/25)\r',
  '   12% (3/25)\r',
  '   16% (4/25)\r',
  '   20% (5/25)\r',
  '   24% (6/25)\r',
  '   28% (7/25)\r',
  '   32% (8/25)\r',
  '   36% (9/25)\r',
  '   40% (10/25)\r',
  '   44% (11/25)\r',
  '   48% (12/25)\r',
  '   52% (13/25)\r',
  '   56% (14/25)\r',
  '   60% (15/25)\r',
  '   64% (16/25)\r',
  '   68% (17/25)\r',
  '   72% (18/25)\r',
  '   76% (19/25)\r',
  '   80% (20/25)\r',
  '   84% (21/25)\r',
  '   88% (22/25)\r',
  '   92% (23/25)\r',
  '   96% (24/25)\r  100% (25/25)\r',
  '  100% (25/25), done.\n'
]

function readAll(chunks: string[]): GitProgressRecord[] {
  const records: GitProgressRecord[] = []
  const read = createGitProgressRecordReader('Updating files', (record) => records.push(record))
  for (const chunk of chunks) {
    read(chunk)
  }
  return records
}

function expectFullCheckout(records: GitProgressRecord[]): void {
  expect(records.map((record) => record.completed)).toEqual([
    ...Array.from({ length: 25 }, (_, index) => index + 1),
    25
  ])
  expect(records.every((record) => record.total === 25)).toBe(true)
  expect(records.at(-2)).toEqual({ percent: 100, completed: 25, total: 25, done: false })
  expect(records.at(-1)).toEqual({ percent: 100, completed: 25, total: 25, done: true })
  expect(records.filter((record) => record.done)).toHaveLength(1)
}

describe('createGitProgressRecordReader', () => {
  it.each([
    ['2.25.5', GIT_2_25_5_CHUNKS],
    ['2.50.1', GIT_2_50_1_CHUNKS],
    ['2.25.5 with a narrow COLUMNS', GIT_2_25_5_NARROW_CHUNKS]
  ])('reads every record git %s wrote, as the pipe chunked it', (_version, chunks) => {
    expectFullCheckout(readAll(chunks))
  })

  it.each([
    ['2.25.5', GIT_2_25_5_CHUNKS],
    ['2.50.1', GIT_2_50_1_CHUNKS],
    ['2.25.5 with a narrow COLUMNS', GIT_2_25_5_NARROW_CHUNKS]
  ])('reads the same records from git %s wherever a chunk boundary falls', (_version, chunks) => {
    const stream = chunks.join('')
    const expected = readAll([stream])
    for (let cut = 1; cut < stream.length; cut += 1) {
      expect(readAll([stream.slice(0, cut), stream.slice(cut)])).toEqual(expected)
    }
    expect(readAll([...stream])).toEqual(expected)
  })

  it('accepts CRLF line ends, even split between chunks', () => {
    expect(readAll(['Updating files:\r', '\n   50% (1/2)\r\n  100% (2/2), done.\r\n'])).toEqual([
      { percent: 50, completed: 1, total: 2, done: false },
      { percent: 100, completed: 2, total: 2, done: true }
    ])
  })

  it('ignores other stderr, including other progress meters', () => {
    expect(
      readAll([
        "Preparing worktree (new branch 'feature')\n",
        'HEAD is now at 1234567 init\n',
        'Filtering content:  50% (1/2)\r',
        'hook: Updating files is not a record\n',
        '   40% (2/5)\n',
        'Updating files: 0% (0/0)\n'
      ])
    ).toEqual([])
  })

  it('stops reading bare counters once the title line is followed by other output', () => {
    expect(
      readAll(['Updating files:\n   50% (1/2)\r', 'post-checkout hook ran\n', '  100% (2/2)\n'])
    ).toEqual([{ percent: 50, completed: 1, total: 2, done: false }])
  })

  it('keeps only a bounded tail of a line that never ends', () => {
    const records: GitProgressRecord[] = []
    const read = createGitProgressRecordReader('Updating files', (record) => records.push(record))
    // The record's head falls out of the bounded buffer before its line ends.
    read(`Updating files:  10% (1/10)${' '.repeat(300)}`)
    read('\r')
    expect(records).toEqual([])
    read('Updating files:  20% (2/10)\r')
    expect(records).toEqual([{ percent: 20, completed: 2, total: 10, done: false }])
  })
})
