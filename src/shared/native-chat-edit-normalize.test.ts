import { describe, expect, it } from 'vitest'
import { editFilesFromToolPair, isEditToolName } from './native-chat-edit-normalize'
import { MAX_EDIT_CHARS, unifiedLineNumber } from './native-chat-edit-model'
import { editLinesFromUnifiedPatch } from './native-chat-unified-patch'
import { unwrapBeginPatch } from './native-chat-begin-patch'

const gutter = (files: ReturnType<typeof editFilesFromToolPair>): (number | null)[] =>
  (files ?? []).flatMap((file) => file.lines.map((line) => unifiedLineNumber(line)))

/** A card takes evidence the edit landed, so these cases report the call as
 *  complete. Cases about the lifecycle itself pass their own state. */
const settledFiles = (
  pair: Parameters<typeof editFilesFromToolPair>[0]
): ReturnType<typeof editFilesFromToolPair> =>
  editFilesFromToolPair({ state: 'completed', ...pair })

describe('editLinesFromUnifiedPatch', () => {
  it('numbers deletes from the old side and adds from the new side', () => {
    const parsed = editLinesFromUnifiedPatch('@@ -12,3 +12,3 @@\n ctx\n-was\n+now\n tail')
    expect(parsed?.lineNumbersKnown).toBe(true)
    expect(parsed?.lines.map((line) => [line.kind, unifiedLineNumber(line)])).toEqual([
      ['context', 12],
      ['del', 13],
      ['add', 13],
      ['context', 14]
    ])
  })

  it('leaves rows unnumbered when the hunk header carries no ranges', () => {
    const parsed = editLinesFromUnifiedPatch('@@\n ctx\n-was\n+now')
    expect(parsed?.lineNumbersKnown).toBe(false)
    expect(parsed?.lines.every((line) => unifiedLineNumber(line) === null)).toBe(true)
  })

  it('returns null for text with no hunk header', () => {
    expect(editLinesFromUnifiedPatch('just prose\n- a bullet')).toBeNull()
  })

  it('keeps the hunk open across a mid-hunk no-newline marker', () => {
    const parsed = editLinesFromUnifiedPatch(
      '@@ -1,2 +1,2 @@\n keep\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file'
    )
    expect(parsed?.lines.map((line) => [line.kind, line.text])).toEqual([
      ['context', 'keep'],
      ['del', 'old'],
      ['add', 'new']
    ])
  })

  it('reads a removed line that starts with `--` as content, not a file header', () => {
    const parsed = editLinesFromUnifiedPatch('@@ -1,4 +1,3 @@\n keep\n--- comment\n-gone\n tail')
    expect(parsed?.lines.map((line) => [line.kind, line.text])).toEqual([
      ['context', 'keep'],
      ['del', '-- comment'],
      ['del', 'gone'],
      ['context', 'tail']
    ])
  })

  it('skips a real file header pair, which only appears outside a hunk', () => {
    const parsed = editLinesFromUnifiedPatch(
      'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-was\n+now'
    )
    expect(parsed?.lines.map((line) => [line.kind, line.text])).toEqual([
      ['del', 'was'],
      ['add', 'now']
    ])
  })

  it('splits CRLF rows without leaving a carriage return or a phantom row', () => {
    const parsed = editLinesFromUnifiedPatch('@@ -1,2 +1,2 @@\r\n ctx\r\n-was\r\n+now\r\n')
    expect(parsed?.lines.map((line) => line.text)).toEqual(['ctx', 'was', 'now'])
  })

  it('reports truncation when the patch text runs past the character cap', () => {
    const body = `@@ -1,1 +1,1 @@\n${'+x\n'.repeat(MAX_EDIT_CHARS)}`
    expect(editLinesFromUnifiedPatch(body)?.truncated).toBe(true)
  })

  it('marks the break between hunks, and only between them', () => {
    const parsed = editLinesFromUnifiedPatch(
      '@@ -40,2 +40,2 @@\n keep\n-was\n@@ -310,2 +310,2 @@\n+now\n tail'
    )
    expect(parsed?.lines.map((line) => [line.kind, unifiedLineNumber(line)])).toEqual([
      ['context', 40],
      ['del', 41],
      ['gap', null],
      ['add', 310],
      ['context', 311]
    ])
  })

  it('reads a body that opens with no hunk header as an unlocatable hunk', () => {
    const parsed = editLinesFromUnifiedPatch('-was\n+now', { implicitFirstHunk: true })
    expect(parsed?.lines.map((line) => line.kind)).toEqual(['del', 'add'])
    expect(parsed?.lineNumbersKnown).toBe(false)
    // Without the option the same body is not a patch at all.
    expect(editLinesFromUnifiedPatch('-was\n+now')).toBeNull()
  })
})

describe('unwrapBeginPatch', () => {
  it('recovers an envelope carried in one word of an argument vector', () => {
    const envelope = '*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** End Patch'
    expect(
      unwrapBeginPatch({
        command: ['bash', '-lc', `apply_patch <<'EOF'\n${envelope}\nEOF`],
        workdir: '/repo'
      })
    ).toBe(envelope)
  })

  it('leaves an already-decoded envelope alone', () => {
    const plain = '*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** End Patch'
    expect(unwrapBeginPatch(plain)).toBe(plain)
  })

  it('ignores input with no envelope', () => {
    expect(unwrapBeginPatch('ls -la')).toBeNull()
  })

  it('declines an envelope with no closing marker rather than swallowing the command line', () => {
    const command = 'bash -c "*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y" && echo ok'
    expect(unwrapBeginPatch(command)).toBeNull()
    expect(settledFiles({ name: 'shell', input: command })).toBeNull()
  })
})

describe('editFilesFromToolPair', () => {
  it('renders an apply_patch run through a command tool, which produced no diff', () => {
    const files = settledFiles({
      name: 'exec',
      input: {
        command: [
          'bash',
          '-lc',
          "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: src/a.ts\n@@\n ctx\n-was\n+now\n*** End Patch\nEOF"
        ]
      }
    })
    expect(files).toHaveLength(1)
    expect(files?.[0]?.path).toBe('src/a.ts')
    expect(files?.[0]?.changeKind).toBe('edited')
    expect(files?.[0]?.added).toBe(1)
    expect(files?.[0]?.removed).toBe(1)
    // Codex hunk headers are context anchors, so no row may claim a file position.
    expect(files?.[0]?.lineNumbersKnown).toBe(false)
  })

  it('numbers an added file from 1', () => {
    const files = settledFiles({
      name: 'exec',
      input:
        "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: new.ts\n+one\n+two\n*** End Patch\nEOF"
    })
    expect(files?.[0]?.changeKind).toBe('added')
    expect(files?.[0]?.lineNumbersKnown).toBe(true)
    expect(gutter(files)).toEqual([1, 2])
  })

  it('keeps a file whose update body carries no hunk header', () => {
    const files = settledFiles({
      name: 'apply_patch',
      input: {
        input:
          '*** Begin Patch\n*** Update File: first.ts\n ctx\n-was\n+now\n*** Update File: second.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n*** End Patch'
      }
    })
    expect(files?.map((file) => file.path)).toEqual(['first.ts', 'second.ts'])
    expect(files?.[0]?.lines.map((line) => line.kind)).toEqual(['context', 'del', 'add'])
    expect(files?.[0]?.lineNumbersKnown).toBe(false)
  })

  it('does not render envelope control lines as file content', () => {
    const files = settledFiles({
      name: 'apply_patch',
      input: {
        input:
          '*** Begin Patch\n*** Environment ID: abc123\n*** Update File: a.ts\n@@\n-was\n+now\n*** End of File\n*** End Patch'
      }
    })
    expect(files?.[0]?.lines.map((line) => line.text)).toEqual(['was', 'now'])
  })

  it('reports a delete that names the file and carries no body', () => {
    const files = settledFiles({
      name: 'apply_patch',
      input: { input: '*** Begin Patch\n*** Delete File: gone.ts\n*** End Patch' }
    })
    expect(files).toHaveLength(1)
    expect(files?.[0]?.changeKind).toBe('deleted')
    expect(files?.[0]?.path).toBe('gone.ts')
    expect(files?.[0]?.lines).toEqual([])
  })

  it('reads a CRLF envelope, whose markers otherwise match nothing', () => {
    const files = settledFiles({
      name: 'apply_patch',
      input: {
        input:
          '*** Begin Patch\r\n*** Update File: a.ts\r\n@@ -1,2 +1,2 @@\r\n-was\r\n+now\r\n*** End Patch'
      }
    })
    expect(files).toHaveLength(1)
    expect(files?.[0]?.path).toBe('a.ts')
    expect(files?.[0]?.lines.map((line) => line.text)).toEqual(['was', 'now'])
  })

  it('marks the break between resolved hunks that sit far apart', () => {
    const files = settledFiles({
      name: 'Edit',
      input: { file_path: '/repo/a.ts' },
      result: {
        editPatch: {
          filePath: '/repo/a.ts',
          hunks: [
            { oldStart: 42, oldLines: 1, newStart: 42, newLines: 1, lines: ['-was', '+now'] },
            { oldStart: 310, oldLines: 1, newStart: 310, newLines: 1, lines: ['-old', '+new'] }
          ]
        }
      }
    })
    expect(files?.[0]?.lines.map((line) => line.kind)).toEqual(['del', 'add', 'gap', 'del', 'add'])
    // A break marks nothing at either end, and counts no change of its own.
    expect(files?.[0]?.added).toBe(2)
    expect(files?.[0]?.removed).toBe(2)
    expect(gutter(files)).toEqual([42, 42, null, 310, 310])
  })

  it('reads a move header as a rename', () => {
    const files = settledFiles({
      name: 'exec',
      input:
        "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n@@\n-a\n+b\n*** End Patch\nEOF"
    })
    expect(files?.[0]?.changeKind).toBe('renamed')
    expect(files?.[0]?.oldPath).toBe('old.ts')
    expect(files?.[0]?.path).toBe('new.ts')
  })

  it('interleaves a Claude snippet pair without claiming line positions', () => {
    const files = settledFiles({
      name: 'Edit',
      input: {
        file_path: '/repo/a.ts',
        old_string: 'keep\nwas\ntail',
        new_string: 'keep\nnow\ntail'
      }
    })
    expect(files?.[0]?.lines.map((line) => line.kind)).toEqual(['context', 'del', 'add', 'context'])
    expect(files?.[0]?.lineNumbersKnown).toBe(false)
  })

  it('prefers the resolved hunks on the result over the snippet pair', () => {
    const files = settledFiles({
      name: 'Edit',
      input: { file_path: '/repo/a.ts', old_string: 'was', new_string: 'now' },
      result: {
        editPatch: {
          filePath: '/repo/a.ts',
          hunks: [
            {
              oldStart: 12,
              oldLines: 3,
              newStart: 12,
              newLines: 3,
              lines: [' ctx', '-was', '+now', ' tail']
            }
          ]
        }
      }
    })
    expect(files?.[0]?.lineNumbersKnown).toBe(true)
    expect(gutter(files)).toEqual([12, 13, 13, 14])
  })

  it('treats a Write the provider reported as a creation as an added file', () => {
    const files = settledFiles({
      name: 'Write',
      input: { file_path: '/repo/new.ts', content: 'one\ntwo\n' },
      result: { output: 'File created successfully at: /repo/new.ts' }
    })
    expect(files?.[0]?.changeKind).toBe('added')
    expect(gutter(files)).toEqual([1, 2])
  })

  it('does not claim a creation for a Write over an existing file', () => {
    const overwrite = settledFiles({
      name: 'Write',
      input: { file_path: '/repo/a.ts', content: 'one\ntwo\n' },
      result: { output: 'The file /repo/a.ts has been updated.' }
    })
    expect(overwrite?.[0]?.changeKind).toBe('edited')
    // With no result at all there is no evidence of a creation either.
    const unreported = settledFiles({
      name: 'Write',
      input: { file_path: '/repo/a.ts', content: 'one\n' }
    })
    expect(unreported?.[0]?.changeKind).toBe('edited')
  })

  it('reads a MultiEdit, whose snippet pairs sit in edits[]', () => {
    const files = settledFiles({
      name: 'MultiEdit',
      input: {
        file_path: '/repo/a.ts',
        edits: [
          { old_string: 'was', new_string: 'now' },
          { old_string: 'gone', new_string: 'kept' }
        ]
      }
    })
    expect(files).toHaveLength(1)
    expect(files?.[0]?.path).toBe('/repo/a.ts')
    // Each entry is its own region, so a break separates them.
    expect(files?.[0]?.lines.map((line) => [line.kind, line.text])).toEqual([
      ['del', 'was'],
      ['add', 'now'],
      ['gap', ''],
      ['del', 'gone'],
      ['add', 'kept']
    ])
    expect(files?.[0]?.added).toBe(2)
    expect(files?.[0]?.removed).toBe(2)
  })

  it('leaves NotebookEdit to the generic tool view', () => {
    expect(isEditToolName('NotebookEdit')).toBe(false)
  })

  it('drops the gutter numbers whenever they locate a snippet rather than the file', () => {
    const files = settledFiles({
      name: 'Edit',
      input: { file_path: '/repo/a.ts', old_string: 'keep\nwas', new_string: 'keep\nnow' }
    })
    expect(files?.[0]?.lineNumbersKnown).toBe(false)
    expect(gutter(files)).toEqual([null, null, null])
    expect(
      files?.[0]?.lines.every((line) => line.oldLineNumber === null && line.newLineNumber === null)
    ).toBe(true)
  })

  it('renders no card for an edit the provider rejected or has not landed', () => {
    const failedInput = { file_path: '/repo/a.ts', old_string: 'missing', new_string: 'now' }
    expect(
      settledFiles({
        name: 'Edit',
        input: failedInput,
        result: { output: 'String to replace not found in file.', isError: true }
      })
    ).toBeNull()
    expect(
      settledFiles({
        name: 'apply_patch',
        input: {
          changes: [{ path: 'a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b' }]
        },
        state: 'failed'
      })
    ).toBeNull()
    expect(settledFiles({ name: 'Edit', input: failedInput, state: 'running' })).toBeNull()
  })

  it('does not read a command tool result as a file edit', () => {
    const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-was\n+now'
    expect(
      settledFiles({
        name: 'exec',
        input: { command: 'git diff' },
        result: { output: patch }
      })
    ).toBeNull()
    // The structured journal's `Diff` item carries its patch only on the result.
    const diffed = settledFiles({
      name: 'Diff',
      input: { path: '/repo/a.ts' },
      result: { output: patch }
    })
    expect(diffed?.[0]?.path).toBe('/repo/a.ts')
    expect(diffed?.[0]?.added).toBe(1)
  })

  it('reports truncation when the content runs past the character cap', () => {
    const files = settledFiles({
      name: 'Write',
      input: { file_path: '/repo/a.ts', content: `${'x'.repeat(MAX_EDIT_CHARS)}\nlast\n` }
    })
    expect(files?.[0]?.truncated).toBe(true)
    // The clipped body ends mid-line, so its one row is real and must survive.
    expect(files?.[0]?.lines).toHaveLength(1)
  })

  it('reads Codex structured changes, stripping the move marker from the body', () => {
    const files = settledFiles({
      name: 'apply_patch',
      input: {
        changes: [
          {
            path: 'old.ts',
            kind: { type: 'update', move_path: 'new.ts' },
            diff: '@@ -1,2 +1,2 @@\n-a\n+b\n\nMoved to: new.ts'
          }
        ]
      }
    })
    expect(files?.[0]?.changeKind).toBe('renamed')
    expect(files?.[0]?.lines.some((line) => line.text.includes('Moved to'))).toBe(false)
    expect(gutter(files)).toEqual([1, 1])
  })

  it('reads a Codex add change, which arrives as raw content with no hunk header', () => {
    const files = settledFiles({
      name: 'apply_patch',
      input: { changes: [{ path: 'new.ts', kind: { type: 'add' }, diff: 'one\ntwo' }] }
    })
    expect(files?.[0]?.changeKind).toBe('added')
    expect(files?.[0]?.added).toBe(2)
  })

  it('renders the file a write actually wrote, not one its content quotes', () => {
    const files = settledFiles({
      name: 'Write',
      input: {
        file_path: 'docs/patch-format.md',
        content:
          'Example:\n\n*** Begin Patch\n*** Update File: src/victim.ts\n@@\n-a\n+b\n*** End Patch\n'
      },
      result: { output: 'File created successfully at: docs/patch-format.md' }
    })
    expect(files?.map((file) => file.path)).toEqual(['docs/patch-format.md'])
    expect(files?.[0]?.lines.some((line) => line.text.includes('Begin Patch'))).toBe(true)
  })

  it('finds an envelope in a command payload that arrived as JSON text', () => {
    const envelope = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-was\n+now\n*** End Patch'
    const files = settledFiles({
      name: 'shell',
      input: JSON.stringify({
        command: ['bash', '-lc', `apply_patch <<'EOF'\n${envelope}\nEOF`],
        workdir: '/repo'
      })
    })
    expect(files?.[0]?.path).toBe('src/a.ts')
    expect(files?.[0]?.added).toBe(1)
  })

  it('renders no card for a call the turn never answered', () => {
    const input = { file_path: '/repo/a.ts', old_string: 'was', new_string: 'now' }
    // No lifecycle and no result: nothing says the edit was applied.
    expect(editFilesFromToolPair({ name: 'Edit', input })).toBeNull()
    expect(editFilesFromToolPair({ name: 'Edit', input, state: 'completed' })).toHaveLength(1)
    expect(editFilesFromToolPair({ name: 'Edit', input, result: { output: 'ok' } })).toHaveLength(1)
  })

  it('splits a multi-file patch into one card per file', () => {
    const files = settledFiles({
      name: 'Diff',
      input: { path: '/repo/one.ts' },
      result: {
        output:
          'diff --git a/one.ts b/one.ts\n--- a/one.ts\n+++ b/one.ts\n@@ -1,1 +1,1 @@\n-first\n+FIRST\n' +
          'diff --git a/two.ts b/two.ts\n--- a/two.ts\n+++ b/two.ts\n@@ -10,1 +10,1 @@\n-second\n+SECOND'
      }
    })
    expect(files?.map((file) => file.path)).toEqual(['one.ts', 'two.ts'])
    expect(files?.[0]?.lines.map((line) => line.text)).toEqual(['first', 'FIRST'])
    expect(gutter(files?.slice(1) ?? null)).toEqual([10, 10])
  })

  it('keeps a file whose envelope section carries no body at all', () => {
    const files = settledFiles({
      name: 'apply_patch',
      input: {
        input:
          '*** Begin Patch\n*** Update File: first.ts\n@@\n-a\n+b\n*** Update File: second.ts\n*** Update File: third.ts\n@@\n-c\n+d\n*** End Patch'
      }
    })
    expect(files?.map((file) => file.path)).toEqual(['first.ts', 'second.ts', 'third.ts'])
    expect(files?.[1]?.lines).toEqual([])
  })

  it('splits a multi-file patch written without per-file preamble lines', () => {
    const files = settledFiles({
      name: 'Diff',
      input: { path: '/repo/one.ts' },
      result: {
        output:
          '--- a/one.ts\n+++ b/one.ts\n@@ -1,1 +1,1 @@\n-first\n+FIRST\n' +
          '--- a/two.ts\n+++ b/two.ts\n@@ -10,1 +10,1 @@\n-second\n+SECOND'
      }
    })
    expect(files?.map((file) => file.path)).toEqual(['one.ts', 'two.ts'])
    expect(gutter(files?.slice(1) ?? null)).toEqual([10, 10])
  })

  it('refuses a card when the call names a file count instead of a file', () => {
    expect(
      settledFiles({
        name: 'Diff',
        input: { path: '2 files' },
        result: { output: '@@\n-a\n+b\n@@\n-c\n+d' }
      })
    ).toBeNull()
  })

  it('reports a clipped patch as truncated instead of rendering its marker', () => {
    const files = settledFiles({
      name: 'Diff',
      input: { path: 'src/a.ts' },
      result: { output: '@@ -1,3 +1,3 @@\n ctx\n-was\n+now\n… (48210 bytes)' }
    })
    expect(files?.[0]?.truncated).toBe(true)
    expect(files?.[0]?.lines.map((line) => line.text)).toEqual(['ctx', 'was', 'now'])
  })

  it('reads a move appended to the patch body as a rename, as the other lane does', () => {
    const files = settledFiles({
      name: 'Diff',
      input: { path: 'src/old.ts' },
      result: { output: '@@ -1,1 +1,1 @@\n-a\n+b\n\nMoved to: src/new.ts' }
    })
    expect(files?.[0]?.changeKind).toBe('renamed')
    expect(files?.[0]?.path).toBe('src/new.ts')
    expect(files?.[0]?.oldPath).toBe('src/old.ts')
    expect(files?.[0]?.lines.some((line) => line.text.includes('Moved to'))).toBe(false)
  })

  it('does not read a row that merely mentions a move as one', () => {
    const body = '@@ -1,2 +1,2 @@\n ctx\n+See Moved to: docs/archive/index.md'
    const fromPatch = settledFiles({
      name: 'Diff',
      input: { path: 'docs/index.md' },
      result: { output: body }
    })
    const fromChanges = settledFiles({
      name: 'apply_patch',
      input: { changes: [{ path: 'docs/index.md', kind: { type: 'update' }, diff: body }] }
    })
    for (const files of [fromPatch, fromChanges]) {
      expect(files?.[0]?.changeKind).toBe('edited')
      expect(files?.[0]?.oldPath).toBeNull()
      expect(files?.[0]?.path).toBe('docs/index.md')
      expect(files?.[0]?.lines.at(-1)?.text).toBe('See Moved to: docs/archive/index.md')
    }
  })

  it('accepts either spelling of the command that applies an envelope', () => {
    const envelope = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-was\n+now\n*** End Patch'
    const files = settledFiles({
      name: 'shell',
      input: { command: ['bash', '-lc', `applypatch <<'EOF'\n${envelope}\nEOF`] }
    })
    expect(files?.[0]?.path).toBe('src/a.ts')
  })

  it('keeps the header destination for a rename the call names by its old path', () => {
    const files = settledFiles({
      name: 'Diff',
      input: { path: 'old.txt' },
      result: {
        output:
          'diff --git a/old.txt b/new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1,1 +1,1 @@\n-a\n+b'
      }
    })
    expect(files?.[0]?.path).toBe('new.txt')
    expect(files?.[0]?.oldPath).toBe('old.txt')
  })

  it('does not read a command that only quotes an envelope as an edit', () => {
    const envelope = '*** Begin Patch\n*** Update File: src/real.ts\n@@\n-a\n+b\n*** End Patch'
    expect(
      settledFiles({
        name: 'shell',
        input: { command: ['bash', '-lc', `cat > notes.md <<'EOF'\n${envelope}\nEOF`] }
      })
    ).toBeNull()
  })

  it('does not call two compared directories a rename', () => {
    const files = settledFiles({
      name: 'Diff',
      input: {},
      result: { output: '--- d1/x.ts\n+++ d2/x.ts\n@@ -1,1 +1,1 @@\n-a\n+b' }
    })
    expect(files?.[0]?.changeKind).toBe('edited')
    expect(files?.[0]?.oldPath).toBeNull()
    expect(files?.[0]?.path).toBe('d2/x.ts')
  })

  it('lets the call name the file when a preamble precedes the only header', () => {
    const files = settledFiles({
      name: 'Diff',
      input: { path: '/repo/one.ts' },
      result: {
        output:
          'warning: something\ndiff --git a/one.ts b/one.ts\n--- a/one.ts\n+++ b/one.ts\n@@ -1,1 +1,1 @@\n-a\n+b'
      }
    })
    // The preamble is its own nameless section, and must not make this look
    // like a patch over several files.
    expect(files?.map((file) => file.path)).toEqual(['/repo/one.ts'])
  })

  it('returns null for a tool that did not edit a file', () => {
    expect(settledFiles({ name: 'Bash', input: { command: 'ls' } })).toBeNull()
    expect(isEditToolName('Bash')).toBe(false)
    expect(isEditToolName('Edit')).toBe(true)
  })
})
