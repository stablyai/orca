import { describe, expect, it } from 'vitest'
import type { FsChangeEvent } from '../../../../shared/filesystem-entry-types'
import { shouldRefreshGitStatusForFileChange } from './git-status-file-watch-refresh'

const root = '/repo'
const ignored = ['A/bin/', 'A/obj/', 'B/bin/junk.o', '.gitignore']

function refreshes(event: FsChangeEvent, ignoredPaths?: readonly string[]): boolean {
  return shouldRefreshGitStatusForFileChange(
    { worktreePath: root, events: [event] },
    root,
    ignoredPaths
  )
}

describe('shouldRefreshGitStatusForFileChange with gitignored paths', () => {
  it('skips writes under an ignored directory or to an ignored file', () => {
    expect(refreshes({ kind: 'update', absolutePath: '/repo/A/obj/Debug/app.dll' }, ignored)).toBe(
      false
    )
    expect(refreshes({ kind: 'create', absolutePath: '/repo/B/bin/junk.o' }, ignored)).toBe(false)
  })

  it('still refreshes for paths git status can report', () => {
    expect(refreshes({ kind: 'create', absolutePath: '/repo/A/new.txt' }, ignored)).toBe(true)
    expect(refreshes({ kind: 'update', absolutePath: '/repo/B/bin/run.sh' }, ignored)).toBe(true)
    expect(refreshes({ kind: 'update', absolutePath: '/repo/A/objective.ts' }, ignored)).toBe(true)
  })

  it('refreshes when a tracked file is renamed into an ignored directory', () => {
    expect(
      refreshes(
        { kind: 'rename', absolutePath: '/repo/A/obj/x.cs', oldAbsolutePath: '/repo/A/x.cs' },
        ignored
      )
    ).toBe(true)
  })

  it('always refreshes for .gitignore edits so the ignored set is rebuilt', () => {
    expect(refreshes({ kind: 'update', absolutePath: '/repo/.gitignore' }, ignored)).toBe(true)
  })

  it('fails open when the ignored set is unknown', () => {
    expect(refreshes({ kind: 'update', absolutePath: '/repo/A/obj/Debug/app.dll' })).toBe(true)
  })
})
