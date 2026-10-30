import { expect, it } from 'vitest'
import { rankQuickOpenFilesWithHistory } from './quick-open-history-ranking'
import {
  getPreparedQuickOpenFiles,
  prepareQuickOpenFiles,
  rankQuickOpenFiles
} from './quick-open-search'

it('puts recently visited matching files first, including empty queries', () => {
  const files = ['apps/api/.env', 'apps/web/.env', 'src/a.ts', 'src/b.ts']
  const history = ['src/b.ts', 'apps/web/.env', 'src/a.ts']
  expect(rankQuickOpenFilesWithHistory('', files, history).map((item) => item.path)).toEqual([
    'src/b.ts',
    'apps/web/.env',
    'src/a.ts',
    'apps/api/.env'
  ])
  expect(
    rankQuickOpenFilesWithHistory('.env api', files, history).map((item) => item.path)
  ).toEqual(['apps/api/.env'])
})

it('preserves ranking without history and excludes ignored/deleted unlisted history', () => {
  const files = ['src/a.ts', 'src/b.ts', 'apps/api/.env']
  expect(rankQuickOpenFilesWithHistory('a', files, [])).toEqual(
    rankQuickOpenFiles('a', prepareQuickOpenFiles(files))
  )
  expect(
    rankQuickOpenFilesWithHistory('', files, ['ignored.bin', 'missing.ts']).map((item) => item.path)
  ).not.toContain('ignored.bin')
})

it.each([1000, 10000])('reuses inventory work across refinements of %i paths', (size) => {
  function measure(files: string[]) {
    const work = { membership: 0, scoring: 0 }
    Object.defineProperty(files, Symbol.iterator, {
      value: function* () {
        for (let index = 0; index < files.length; index++) {
          work.membership++
          yield files[index]
        }
      }
    })
    for (const file of getPreparedQuickOpenFiles(files)) {
      const lowerPath = file.lowerPath
      Object.defineProperty(file, 'lowerPath', {
        get() {
          work.scoring++
          return lowerPath
        }
      })
    }
    return {
      work,
      rank(query: string, history: string[]) {
        work.membership = 0
        work.scoring = 0
        return rankQuickOpenFilesWithHistory(query, files, history).map((item) => item.path)
      }
    }
  }

  const needles = Array.from({ length: 10 }, (_, index) => `needle/${index}.ts`)
  const others = Array.from({ length: size - 11 }, (_, index) => `other/${index}.ts`)
  const files = [...needles, 'new/0.ts', ...others]
  const measured = measure(files)
  const history = [needles[9], 'needle/added.ts', 'missing.ts']
  const narrow = [needles[9], ...needles.slice(0, 9)]
  const broad = [...narrow, 'new/0.ts']
  expect(measured.rank('n', history)).toEqual(broad)
  expect(measured.work.membership).toBe(size)
  expect(measured.work.scoring).toBeGreaterThanOrEqual(size)

  for (const query of ['ne', 'needle', 'needle']) {
    expect(measured.rank(query, history)).toEqual(query === 'ne' ? broad : narrow)
    expect(measured.work.membership).toBe(0)
    expect(measured.work.scoring).toBeGreaterThan(0)
    expect(measured.work.scoring).toBeLessThanOrEqual(300)
  }
  expect(measured.rank('n', history)).toEqual(broad)
  expect(measured.work.membership).toBe(0)
  expect(measured.work.scoring).toBeGreaterThanOrEqual(size)
  for (const query of ['t', 'ts']) {
    expect(measured.rank(query, history)).toEqual([...broad, ...others.slice(0, 39)])
    expect(measured.work.membership).toBe(0)
    expect(measured.work.scoring).toBeGreaterThanOrEqual(size)
  }

  const replacement = measure([...needles.slice(1), 'needle/added.ts', 'new/0.ts', ...others])
  expect(replacement.rank('needle', ['needle/added.ts', needles[0], needles[9]])).toEqual([
    'needle/added.ts',
    needles[9],
    ...needles.slice(1, 9)
  ])
  expect(replacement.work.membership).toBe(size)
  expect(replacement.work.scoring).toBeGreaterThanOrEqual(size)
  expect(replacement.rank('needle added', ['needle/added.ts', needles[0]])).toEqual([
    'needle/added.ts'
  ])
  expect(replacement.work.membership).toBe(0)
  expect(replacement.work.scoring).toBeLessThanOrEqual(400)
})
