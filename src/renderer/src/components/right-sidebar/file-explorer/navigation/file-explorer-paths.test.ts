import { expect, it } from 'vitest'
import { getRevealTarget } from './file-explorer-paths'

it('re-spells a forward-slash reveal target to match a Windows root', () => {
  expect(getRevealTarget('C:\\Projects\\other', 'C:/Projects/other/docs/api')).toEqual({
    targetPath: 'C:\\Projects\\other\\docs\\api',
    ancestorDirs: ['C:\\Projects\\other\\docs']
  })
})

it('keeps a POSIX folder whose name contains a backslash as one listed segment', () => {
  expect(getRevealTarget('/repo', '/repo/foo\\node_modules/index.js')).toEqual({
    targetPath: '/repo/foo\\node_modules/index.js',
    ancestorDirs: ['/repo/foo\\node_modules']
  })
})

it('has nothing to reveal under a node_modules the root holds', () => {
  expect(getRevealTarget('/repo', '/repo/node_modules/pkg/index.js')).toBeNull()
})

it('stops at the folder holding a nested .git', () => {
  expect(getRevealTarget('/repo', '/repo/src/app/.git/objects/pack')).toEqual({
    targetPath: '/repo/src/app',
    ancestorDirs: ['/repo/src']
  })
})

it('returns null for a path outside the root', () => {
  expect(getRevealTarget('/repo', '/other/file.ts')).toBeNull()
})
