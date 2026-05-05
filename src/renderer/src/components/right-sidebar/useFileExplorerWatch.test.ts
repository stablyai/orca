import { describe, expect, it } from 'vitest'
import { getExternalFileChangeRelativePath } from './useFileExplorerWatch'

describe('getExternalFileChangeRelativePath', () => {
  it('returns a worktree-relative file path for external file updates', () => {
    expect(getExternalFileChangeRelativePath('/repo', '/repo/config/settings.json', false)).toBe(
      'config/settings.json'
    )
  })

  it('ignores directory events so only file tabs reload', () => {
    expect(getExternalFileChangeRelativePath('/repo', '/repo/config', true)).toBeNull()
  })

  it('treats isDirectory=undefined as a file so delete events still notify', () => {
    // Why: delete events from the watcher arrive with isDirectory=undefined
    // because the path no longer exists on disk (design §4.4). Gating on
    // `isDirectory !== true` ensures the editor is still notified so stale
    // tab contents get invalidated.
    expect(
      getExternalFileChangeRelativePath('/repo', '/repo/config/settings.json', undefined)
    ).toBe('config/settings.json')
  })

  it('normalizes Windows separators before deriving the relative path', () => {
    expect(
      getExternalFileChangeRelativePath('C:\\repo', 'C:\\repo\\config\\settings.json', false)
    ).toBe('config/settings.json')
  })

  it('ignores paths outside the active worktree', () => {
    expect(
      getExternalFileChangeRelativePath('/repo', '/other/config/settings.json', false)
    ).toBeNull()
  })

  it('rejects sibling worktrees whose path merely shares a prefix', () => {
    // Why: string-prefix checks without a trailing separator would match
    // `/repo-other/...` as if it were inside `/repo`, leaking events across
    // worktrees.
    expect(getExternalFileChangeRelativePath('/repo', '/repo-other/file.ts', false)).toBeNull()
  })

  it('returns null when the changed path is the worktree root itself', () => {
    expect(getExternalFileChangeRelativePath('/repo', '/repo', false)).toBeNull()
  })

  it('tolerates a trailing slash on the worktree path', () => {
    expect(getExternalFileChangeRelativePath('/repo/', '/repo/src/index.ts', false)).toBe(
      'src/index.ts'
    )
  })

  it('preserves nested segments in the returned relative path', () => {
    expect(getExternalFileChangeRelativePath('/repo', '/repo/a/b/c/deep.ts', false)).toBe(
      'a/b/c/deep.ts'
    )
  })
})
