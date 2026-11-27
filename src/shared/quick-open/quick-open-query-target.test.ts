import { expect, it } from 'vitest'
import {
  isQuickOpenAbsolutePath,
  isQuickOpenDirectPath,
  isQuickOpenHomePath,
  parseQuickOpenQueryTarget
} from './quick-open-query-target'

it.each([
  ['src/app.ts:12', { pathQuery: 'src/app.ts', line: 12 }],
  ['~/.zshrc:12:3', { pathQuery: '~/.zshrc', line: 12, column: 3 }],
  ['~\\notes\\todo.md:4', { pathQuery: '~\\notes\\todo.md', line: 4 }]
])('parses the trailing location in %s', (query, target) => {
  expect(parseQuickOpenQueryTarget(query)).toEqual(target)
})

it.each(['~/.zshrc', '~/notes/todo.md', '~\\notes\\todo.md'])(
  'recognizes a home-relative direct path: %s',
  (path) => {
    expect(isQuickOpenHomePath(path)).toBe(true)
    expect(isQuickOpenDirectPath(path)).toBe(true)
    expect(isQuickOpenAbsolutePath(path)).toBe(false)
  }
)

it.each(['~', '~alice/.zshrc', 'src/~/file.ts', '~/\0bad'])(
  'does not treat %s as a home-relative direct path',
  (path) => {
    expect(isQuickOpenHomePath(path)).toBe(false)
    expect(isQuickOpenDirectPath(path)).toBe(false)
  }
)
