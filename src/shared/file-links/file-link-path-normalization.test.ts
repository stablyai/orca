import { expect, it } from 'vitest'
import {
  joinAbsolutePath,
  normalizeAbsolutePath,
  resolveTildePath
} from './file-link-path-normalization'

it('preserves POSIX filename backslashes while resolving file links against their host root', () => {
  expect(normalizeAbsolutePath('/home/alice/report\\draft.txt')).toEqual({
    normalized: '/home/alice/report\\draft.txt',
    comparisonKey: '/home/alice/report\\draft.txt',
    rootKind: 'posix'
  })
  expect(joinAbsolutePath('/home/alice', '\\draft.txt')).toBe('/home/alice/\\draft.txt')
  expect(resolveTildePath('~/report\\draft.txt', '/home/alice/project')).toBe(
    '/home/alice/report\\draft.txt'
  )
  expect(resolveTildePath('~/draft.txt', '/home/alice\\smith/project')).toBe(
    '/home/alice\\smith/draft.txt'
  )
  expect(joinAbsolutePath('C:\\Users\\alice', 'report\\draft.txt')).toBe(
    'C:/Users/alice/report/draft.txt'
  )
})
