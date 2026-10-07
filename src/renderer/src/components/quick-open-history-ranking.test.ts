import { expect, it } from 'vitest'
import { rankQuickOpenFilesWithHistory } from './quick-open-history-ranking'
import { prepareQuickOpenFiles, rankQuickOpenFiles } from './quick-open-search'

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
