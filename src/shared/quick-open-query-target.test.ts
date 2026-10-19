import { expect, it } from 'vitest'
import { isQuickOpenAbsolutePath, parseQuickOpenQueryTarget } from './quick-open-query-target'

it.each([
  ['src/app.ts:12', { pathQuery: 'src/app.ts', line: 12 }],
  ['C:\\src\\app.ts:12:3', { pathQuery: 'C:\\src\\app.ts', line: 12, column: 3 }],
  ['\\\\server\\share\\app.ts:2', { pathQuery: '\\\\server\\share\\app.ts', line: 2 }],
  ['/home/a b/file.ts:7:8', { pathQuery: '/home/a b/file.ts', line: 7, column: 8 }],
  ['file:part:2', { pathQuery: 'file:part', line: 2 }]
])('parses the trailing location in %s', (query, target) => {
  expect(parseQuickOpenQueryTarget(query)).toEqual(target)
})

it.each([
  'C:12',
  'file:0',
  'file:1:0',
  'file:1:',
  'file:-2',
  'file:1:9007199254740992',
  'file::2',
  'file:9007199254740992'
])('keeps invalid or ambiguous suffixes literal: %s', (query) => {
  expect(parseQuickOpenQueryTarget(query)).toEqual({ pathQuery: query })
})

it.each([
  '/home/app.ts',
  'C:/src/app.ts',
  'C:\\src\\app.ts',
  '\\\\server\\share\\app.ts',
  '//server/share/app.ts'
])('recognizes an absolute path: %s', (path) => {
  expect(isQuickOpenAbsolutePath(path)).toBe(true)
})

it.each(['C:app.ts', 'src/app.ts', 'https://host/app.ts', '/tmp/\0bad'])(
  'does not offer a direct path for %s',
  (path) => {
    expect(isQuickOpenAbsolutePath(path)).toBe(false)
  }
)
