import { expect, it } from 'vitest'
import { rankQuickOpenFilesWithHistory } from './quick-open-history-ranking'

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
