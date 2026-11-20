import { describe, expect, it } from 'vitest'
import type { FsChangedPayload } from '../../../../shared/file-watch/filesystem-change-event'
import type { GitDiffTextResult } from '../../../../shared/git/diff/git-diff-compare-types'
import {
  isWatchedTurnDiffFile,
  mergeNativeChatTurnDiffs,
  watchedEditFileFromGitDiff,
  watchedFilePathsFromFsPayload,
  watchedTurnDiffWithFile
} from './native-chat-watched-turn-diffs'

function payload(events: FsChangedPayload['events'], worktreePath = 'D:\\repo'): FsChangedPayload {
  return { worktreePath, events }
}

function textDiff(original: string, modified: string): GitDiffTextResult {
  return {
    kind: 'text',
    originalContent: original,
    modifiedContent: modified,
    originalIsBinary: false,
    modifiedIsBinary: false
  }
}

describe('watchedFilePathsFromFsPayload', () => {
  it('keeps files inside the root and skips directories and excluded segments', () => {
    const { paths } = watchedFilePathsFromFsPayload(
      payload([
        { kind: 'update', absolutePath: 'D:\\repo\\src\\a.ts' },
        { kind: 'update', absolutePath: 'D:\\repo\\src', isDirectory: true },
        { kind: 'update', absolutePath: 'D:\\repo\\node_modules\\pkg\\index.js' },
        { kind: 'update', absolutePath: 'D:\\repo\\.git\\index' },
        { kind: 'update', absolutePath: 'D:\\other\\b.ts' }
      ]),
      'D:\\repo'
    )
    expect(paths).toEqual(['src/a.ts'])
  })

  it('tracks both halves of a rename and flags overflow payloads', () => {
    const renamed = watchedFilePathsFromFsPayload(
      payload([
        {
          kind: 'rename',
          absolutePath: 'D:\\repo\\new.ts',
          oldAbsolutePath: 'D:\\repo\\old.ts'
        }
      ]),
      'D:\\repo'
    )
    expect(new Set(renamed.paths)).toEqual(new Set(['new.ts', 'old.ts']))
    expect(renamed.overflow).toBe(false)

    const overflow = watchedFilePathsFromFsPayload(
      payload([{ kind: 'overflow', absolutePath: '' }]),
      'D:\\repo'
    )
    expect(overflow.overflow).toBe(true)
  })
})

describe('watchedEditFileFromGitDiff', () => {
  it('builds an added-file card for an untracked create', () => {
    const file = watchedEditFileFromGitDiff('src/new.ts', textDiff('', 'one\ntwo\n'), 'create')!
    expect(file.changeKind).toBe('added')
    expect(file.added).toBe(2)
    expect(file.removed).toBe(0)
    expect(file.lineNumbersKnown).toBe(true)
  })

  it('builds a deleted-file card when the working tree copy is gone', () => {
    const file = watchedEditFileFromGitDiff('src/gone.ts', textDiff('one\ntwo\n', ''), 'delete')!
    expect(file.changeKind).toBe('deleted')
    expect(file.removed).toBe(2)
  })

  it('collapses far context between change regions into gap rows', () => {
    const original = Array.from({ length: 400 }, (_, i) => `line${i}`).join('\n')
    const modified = original.replace('line10', 'changed10').replace('line300', 'changed300')
    const file = watchedEditFileFromGitDiff('a.ts', textDiff(original, modified), 'update', 3)!
    expect(file.changeKind).toBe('edited')
    const kinds = file.lines.map((line) => line.kind)
    expect(kinds).toContain('gap')
    expect(kinds).toContain('del')
    expect(kinds).toContain('add')
    // Context within 3 rows of each change stays numbered; the 280-line
    // stretch between regions became one gap.
    const context = file.lines.filter((line) => line.kind === 'context')
    expect(context.length).toBeLessThanOrEqual(16)
    expect(context.every((line) => line.oldLineNumber !== null)).toBe(true)
  })

  it('drops binary diffs', () => {
    expect(
      watchedEditFileFromGitDiff('img.png', {
        kind: 'binary',
        originalContent: '',
        modifiedContent: '',
        originalIsBinary: true,
        modifiedIsBinary: true
      })
    ).toBeNull()
  })
})

describe('watchedTurnDiffWithFile', () => {
  it('accumulates files and replaces a path on re-resolve', () => {
    const first = watchedEditFileFromGitDiff('a.ts', textDiff('x\n', 'y\n'), 'update')!
    const second = watchedEditFileFromGitDiff('a.ts', textDiff('x\n', 'z\nw\n'), 'update')!
    let diff = watchedTurnDiffWithFile(undefined, first)
    diff = watchedTurnDiffWithFile(diff, second)
    expect(diff.files).toHaveLength(1)
    expect(diff.files[0]?.added).toBe(2)
    expect(diff.files[0]?.removed).toBe(1)
  })
})

describe('mergeNativeChatTurnDiffs', () => {
  it('prefers tool-call entries for shared paths and appends watcher-only files', () => {
    const watchedFile = watchedEditFileFromGitDiff('a.ts', textDiff('x\n', 'y\n'), 'update')!
    const other = watchedEditFileFromGitDiff('b.ts', textDiff('', 'n\n'), 'create')!
    const watched = watchedTurnDiffWithFile(watchedTurnDiffWithFile(undefined, watchedFile), other)
    const observed = {
      files: [
        {
          path: 'a.ts',
          added: 1,
          removed: 1,
          truncated: false,
          target: { messageId: 'm', editKey: 'e', fileIndex: 0 },
          edits: []
        }
      ],
      added: 1,
      removed: 1,
      truncated: false
    }
    const merged = mergeNativeChatTurnDiffs(observed, watched)!
    expect(merged.files).toHaveLength(2)
    expect(merged.files[0]?.path).toBe('a.ts')
    expect(isWatchedTurnDiffFile(merged.files[0]!)).toBe(false)
    expect(isWatchedTurnDiffFile(merged.files[1]!)).toBe(true)
    expect(merged.files[1]?.path).toBe('b.ts')
    // Tool-call counts come from the recorded patch (1/1); watcher b.ts adds 1/0.
    expect(merged.added).toBe(2)
    expect(merged.removed).toBe(1)
  })

  it('returns undefined when neither source has rows', () => {
    expect(mergeNativeChatTurnDiffs(undefined, undefined)).toBeUndefined()
  })
})
