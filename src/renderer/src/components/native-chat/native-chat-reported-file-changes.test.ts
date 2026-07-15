import { describe, expect, it } from 'vitest'
import type { NativeChatReportedFileChangeStep } from './native-chat-reported-file-changes'
import {
  collectNativeChatReportedFileChanges,
  MAX_REPORTED_FILE_CHANGE_TEXT_CHARS
} from './native-chat-reported-file-changes'
import { extractNativeChatReportedFilePatch } from './native-chat-reported-file-change-parser-patch'

function step(
  name: string,
  input: unknown,
  result: {
    output: string
    isError?: boolean
    outcome?: 'success' | 'error' | 'unknown'
  } | null = { output: 'done' }
): NativeChatReportedFileChangeStep {
  return {
    call: { type: 'tool-call', name, input },
    result: result ? { type: 'tool-result', ...result } : null
  }
}

describe('collectNativeChatReportedFileChanges', () => {
  it('includes only completed successful editing calls', () => {
    const changes = collectNativeChatReportedFileChanges([
      step('Edit', { file_path: 'src/done.ts' }),
      step('Write', { path: 'src/pending.ts' }, null),
      step('apply_patch', '*** Add File: src/failed.ts', { output: 'failed', isError: true }),
      step('Bash', { command: 'printf diff' }, { output: '--- /dev/null\n+++ b/src/not-edit.ts' }),
      { call: null, result: { type: 'tool-result', output: 'orphan' } }
    ])

    expect(changes).toEqual({
      truncated: false,
      changes: [{ path: 'src/done.ts', status: 'modified', binary: false, stepIndexes: [0] }]
    })
  })

  it('deduplicates repeated edits and preserves an addition over later modifications', () => {
    const changes = collectNativeChatReportedFileChanges([
      step('functions.apply_patch', '*** Add File: src/new.ts\n+first'),
      step('Edit', { file_path: 'src/new.ts', old_string: 'first', new_string: 'second' }),
      step('str_replace', { path: 'src/new.ts', old: 'second', new: 'third' })
    ])

    expect(changes.changes).toEqual([
      { path: 'src/new.ts', status: 'added', binary: false, stepIndexes: [0, 1, 2] }
    ])
  })

  it('normalizes Windows separators while preserving Unix paths', () => {
    const changes = collectNativeChatReportedFileChanges([
      step('Edit', { filePath: 'C:\\Work\\Orca\\src\\app.ts' }),
      step('MultiEdit', { file_path: '/srv/orca/src/app.ts' })
    ])

    expect(changes.changes.map((change) => change.path)).toEqual([
      'C:/Work/Orca/src/app.ts',
      '/srv/orca/src/app.ts'
    ])
  })

  it('reads add, update, delete, and move operations from an apply-patch input', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/added.ts',
      '+new',
      '*** Update File: src/old name.ts',
      '*** Move to: src/new name.ts',
      '*** Delete File: src/deleted.ts',
      '*** End Patch'
    ].join('\n')

    expect(collectNativeChatReportedFileChanges([step('apply_patch', patch)]).changes).toEqual([
      { path: 'src/added.ts', status: 'added', binary: false, stepIndexes: [0] },
      {
        path: 'src/new name.ts',
        status: 'renamed',
        previousPath: 'src/old name.ts',
        binary: false,
        stepIndexes: [0]
      },
      { path: 'src/deleted.ts', status: 'deleted', binary: false, stepIndexes: [0] }
    ])
  })

  it('reads quoted Git paths, renames, and binary markers from successful output', () => {
    const output = [
      'diff --git "a/assets/old name.bin" "b/assets/new name.bin"',
      'similarity index 100%',
      'rename from assets/old name.bin',
      'rename to assets/new name.bin',
      'GIT binary patch'
    ].join('\n')

    expect(collectNativeChatReportedFileChanges([step('Edit', {}, { output })]).changes).toEqual([
      {
        path: 'assets/new name.bin',
        status: 'renamed',
        previousPath: 'assets/old name.bin',
        binary: true,
        stepIndexes: [0]
      }
    ])
  })

  it('infers added and deleted files from unified-diff null paths', () => {
    const output = [
      '--- /dev/null',
      '+++ "b/src/added name.ts"',
      '+one',
      '--- "a/src/deleted name.ts"',
      '+++ /dev/null',
      '-one'
    ].join('\n')

    expect(
      collectNativeChatReportedFileChanges([step('apply_patch', '', { output })]).changes
    ).toEqual([
      { path: 'src/added name.ts', status: 'added', binary: false, stepIndexes: [0] },
      { path: 'src/deleted name.ts', status: 'deleted', binary: false, stepIndexes: [0] }
    ])
  })

  it('caps scanned result output across all steps before later paths are considered', () => {
    const firstOutput = 'x'.repeat(MAX_REPORTED_FILE_CHANGE_TEXT_CHARS - 2)
    const secondOutput = 'xx\n--- /dev/null\n+++ b/late.ts'

    expect(
      collectNativeChatReportedFileChanges([
        step('apply_patch', '', { output: firstOutput }),
        step('apply_patch', '', { output: secondOutput })
      ])
    ).toEqual({ changes: [], truncated: true })
  })

  it('accepts explicit success and excludes explicit error or unknown outcomes', () => {
    const collection = collectNativeChatReportedFileChanges([
      step('apply_patch', '*** Add File: src/success.ts\n+ok', {
        output: 'done',
        isError: true,
        outcome: 'success'
      }),
      step('apply_patch', '*** Add File: src/error.ts\n+no', {
        output: 'done',
        outcome: 'error'
      }),
      step('apply_patch', '*** Add File: src/unknown.ts\n+maybe', {
        output: 'done',
        outcome: 'unknown'
      })
    ])

    expect(collection.changes.map((change) => change.path)).toEqual(['src/success.ts'])
  })

  it('preserves rename lineage and additions through later edits and moves', () => {
    const renamed = collectNativeChatReportedFileChanges([
      step('apply_patch', '*** Update File: src/a.ts\n*** Move to: src/b.ts'),
      step('Edit', { path: 'src/b.ts' }),
      step('apply_patch', '*** Update File: src/b.ts\n*** Move to: src/c.ts'),
      step('Edit', { path: 'src/c.ts' })
    ])
    expect(renamed.changes).toEqual([
      {
        path: 'src/c.ts',
        status: 'renamed',
        previousPath: 'src/a.ts',
        binary: false,
        stepIndexes: [0, 1, 2, 3]
      }
    ])

    const added = collectNativeChatReportedFileChanges([
      step('apply_patch', '*** Add File: src/new.ts\n+new'),
      step('apply_patch', '*** Update File: src/new.ts\n*** Move to: src/moved.ts'),
      step('Edit', { path: 'src/moved.ts' })
    ])
    expect(added.changes[0]).toMatchObject({ path: 'src/moved.ts', status: 'added' })
  })

  it('uses the shared Git C-quoted decoder for UTF-8 octal paths', () => {
    const output = [
      'diff --git "a/src/\\303\\251.ts" "b/src/\\303\\251.ts"',
      '--- "a/src/\\303\\251.ts"',
      '+++ "b/src/\\303\\251.ts"',
      '+new'
    ].join('\n')

    expect(
      collectNativeChatReportedFileChanges([step('apply_patch', '', { output })]).changes[0]?.path
    ).toBe('src/é.ts')
  })

  it('deduplicates Windows and WSL aliases while keeping POSIX paths case-sensitive', () => {
    const collection = collectNativeChatReportedFileChanges([
      step('Edit', { path: 'C:\\Work\\Orca\\src\\App.ts' }),
      step('Edit', { path: 'c:/work/orca/src/app.ts' }),
      step('Edit', { path: '\\\\SERVER\\Share\\Folder\\File.ts' }),
      step('Edit', { path: '//server/share/folder/file.ts' }),
      step('Edit', { path: '\\\\wsl.localhost\\Ubuntu\\home\\user\\File.ts' }),
      step('Edit', { path: '//wsl$/ubuntu/home/user/File.ts' }),
      step('Edit', { path: '/srv/orca/App.ts' }),
      step('Edit', { path: '/srv/orca/app.ts' })
    ])

    expect(collection.changes.map((change) => change.path)).toEqual([
      'C:/Work/Orca/src/App.ts',
      '//SERVER/Share/Folder/File.ts',
      '//wsl.localhost/Ubuntu/home/user/File.ts',
      '/srv/orca/App.ts',
      '/srv/orca/app.ts'
    ])
  })

  it('marks the aggregate partial when the file count is capped', () => {
    const patch = Array.from(
      { length: 201 },
      (_, index) => `*** Add File: src/${index}.ts\n+${index}`
    ).join('\n')
    const collection = collectNativeChatReportedFileChanges([step('apply_patch', patch)])

    expect(collection.changes).toHaveLength(200)
    expect(collection.truncated).toBe(true)
  })

  it('never reports a path cut in the middle of a bounded patch line', () => {
    const partialHeader = `*** Add File: src/${'a'.repeat(MAX_REPORTED_FILE_CHANGE_TEXT_CHARS)}.ts`
    const collection = collectNativeChatReportedFileChanges([step('apply_patch', partialHeader)])

    expect(collection).toEqual({ changes: [], truncated: true })
  })

  it('bounds provider output before normalizing a selected file patch', () => {
    const output = `*** Add File: src/early.ts\r\n+early\r\n${'ignored\r\n'.repeat(100_000)}`
    const selected = extractNativeChatReportedFilePatch(output, 'src/early.ts', {
      maxChars: 128,
      maxLines: 20
    })

    expect(selected?.text).toContain('*** Add File: src/early.ts\n+early')
    expect(selected?.truncated).toBe(true)
    expect(selected?.text.length).toBeLessThanOrEqual(128)
  })
})
