import { describe, expect, it } from 'vitest'
import {
  FILE_EXPLORER_FULL_ROOT,
  migrateExplorerDisplayRoots,
  normalizeExplorerDisplayRootByWorktree
} from './file-explorer-display-root'

describe('explorer root persistence', () => {
  it('preserves existing sparse worktrees without overriding explicit choices', () => {
    expect(
      migrateExplorerDisplayRoots({ chosen: 'packages/app' }, false, {
        old: { sparseDirectories: ['src'] },
        chosen: { sparseDirectories: ['packages/app'] },
        normal: {}
      })
    ).toEqual({ old: FILE_EXPLORER_FULL_ROOT, chosen: 'packages/app' })
  })
  it('does not seed newly created worktrees on subsequent loads', () => {
    const migrated = migrateExplorerDisplayRoots({}, false, { old: { sparseDirectories: ['src'] } })
    expect(
      migrateExplorerDisplayRoots(migrated, true, {
        old: { sparseDirectories: ['src'] },
        newlyCreated: { sparseDirectories: ['app'] }
      })
    ).toEqual({ old: FILE_EXPLORER_FULL_ROOT })
  })
  it('rejects malformed records and unsafe keys', () => {
    expect(normalizeExplorerDisplayRootByWorktree(['src'])).toEqual({})
    expect(
      normalizeExplorerDisplayRootByWorktree(
        JSON.parse('{"__proto__":"src","constructor":"src","ok":"/","bad":false}')
      )
    ).toEqual({ ok: '/' })
  })
})
