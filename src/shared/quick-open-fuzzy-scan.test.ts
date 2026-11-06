import { expect, it } from 'vitest'
import { prepareQuickOpenFiles, rankQuickOpenFiles } from './quick-open-path-search'

it.each([
  { query: 'az', score: 3997 },
  { query: 'aq', score: null }
])('skips nonmatching path spans for $query', ({ query, score }) => {
  const path = `a/${'x'.repeat(4000)}/z.ts`
  const [prepared] = prepareQuickOpenFiles([path])
  let pathReads = 0
  const measured = {
    ...prepared,
    get lowerPath() {
      pathReads++
      return prepared.lowerPath
    }
  }
  expect(rankQuickOpenFiles(query, [measured])).toEqual(score === null ? [] : [{ path, score }])
  expect(pathReads).toBeLessThanOrEqual(20)
})
