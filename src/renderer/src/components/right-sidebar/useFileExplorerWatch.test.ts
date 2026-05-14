import { describe, expect, it } from 'vitest'
import type { FsChangedPayload } from '../../../../shared/types'
import {
  getExternalFileChangeRelativePath,
  payloadRequiresDeferredTreeRefresh
} from './useFileExplorerWatch'

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

describe('payloadRequiresDeferredTreeRefresh', () => {
  function payload(events: FsChangedPayload['events'], worktreePath = '/repo'): FsChangedPayload {
    return { worktreePath, events }
  }

  it('does not require a full tree refresh for replayable deferred changes', () => {
    const changes = payload([
      { kind: 'create', absolutePath: '/repo/src/new.ts', isDirectory: false },
      { kind: 'update', absolutePath: '/repo/src', isDirectory: true },
      { kind: 'delete', absolutePath: '/repo/src/old.ts' }
    ])

    expect(payloadRequiresDeferredTreeRefresh(changes, '/repo')).toBe(false)
  })

  it('requires a full tree refresh for unreplayable rename payloads in the current worktree', () => {
    const changes = payload([
      { kind: 'rename', absolutePath: '/repo/src/old.ts', isDirectory: false }
    ])

    expect(payloadRequiresDeferredTreeRefresh(changes, '/repo')).toBe(true)
  })

  it('ignores stale deferred rename payloads from a previous worktree', () => {
    const changes = payload(
      [{ kind: 'rename', absolutePath: '/other/src/old.ts', isDirectory: false }],
      '/other'
    )

    expect(payloadRequiresDeferredTreeRefresh(changes, '/repo')).toBe(false)
  })
})
