import { expect, it } from 'vitest'
import { compareFileNames } from './file-name-sort'
import {
  prepareQuickOpenFiles,
  QuickOpenPathRanker,
  rankQuickOpenFiles,
  type QuickOpenIndexedFile
} from './quick-open-path-search'

function referenceScore(query: string, file: QuickOpenIndexedFile): number {
  let qi = 0
  let score = 0
  let lastMatch = -1
  for (let ti = 0; ti < file.lowerPath.length && qi < query.length; ti++) {
    if (file.lowerPath[ti] !== query[qi]) {
      continue
    }
    score += lastMatch === -1 ? 0 : ti - lastMatch - 1
    if (ti > 0 && '/.-'.includes(file.lowerPath[ti - 1])) {
      score -= 5
    }
    lastMatch = ti
    qi++
  }
  if (qi < query.length) {
    return -1
  }
  return score - (file.lowerFilename.includes(query) ? 100 : 0)
}

it.each(['az', 'aq'])('skips nonmatching path spans for %s', (query) => {
  const [prepared] = prepareQuickOpenFiles([`a/${'x'.repeat(4000)}/z.ts`])
  let pathReads = 0
  const measured = {
    ...prepared,
    get lowerPath() {
      pathReads++
      return prepared.lowerPath
    }
  }
  expect(rankQuickOpenFiles(query, [measured])).toEqual(rankQuickOpenFiles(query, [prepared]))
  expect(pathReads).toBeLessThanOrEqual(20)
})

it('preserves code-unit scores and ordering for generated Unicode paths and queries', () => {
  const alphabet = [
    'a',
    'b',
    'c',
    '/',
    '\\',
    '.',
    '-',
    '2',
    '0',
    'é',
    'e\u0301',
    'İ',
    '😀',
    '\ud800',
    '\udc00'
  ]
  let seed = 43
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed
  }
  const paths = ['a.../b', 'a/x/z', 'a/z', '😀.ts', 'a'.repeat(110), 'aa', 'same', 'same', '']
  for (let index = 0; index < 1000; index++) {
    const length = next() % 80
    let path = ''
    for (let offset = 0; offset < length; offset++) {
      path += alphabet[next() % alphabet.length]
    }
    paths.push(path)
  }
  const files = prepareQuickOpenFiles(paths)
  const queries = [
    '',
    ' ',
    'az',
    'ab',
    'a',
    'aa',
    'q',
    '😀',
    '\ud800',
    '\udc00',
    'é',
    'e\u0301',
    'İ',
    'a\\b',
    '  A  '
  ]
  for (let index = 0; index < 100; index++) {
    queries.push(`${alphabet[next() % alphabet.length]}${alphabet[next() % alphabet.length]}`)
  }
  for (const query of queries) {
    const normalized = query.trim().replace(/\\/g, '/').toLowerCase()
    const expected = files
      .map((file) => ({ ...file, score: normalized ? referenceScore(normalized, file) : 0 }))
      .filter((file) => file.score !== -1)
      .sort(
        (a, b) =>
          a.score - b.score || compareFileNames(a.path, b.path) || a.inputIndex - b.inputIndex
      )
    for (const limit of [1, 16, 50]) {
      const selected = expected.slice(0, limit).map(({ path, score }) => ({ path, score }))
      expect(rankQuickOpenFiles(query, files, limit)).toEqual(selected)
      const streamed = new QuickOpenPathRanker(query, limit)
      paths.forEach((path) => streamed.consider(path))
      expect(streamed.result()).toEqual({
        paths: selected.map((entry) => entry.path),
        totalCount: expected.length
      })
    }
  }
})
