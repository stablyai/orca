import { describe, it, expect } from 'vitest'
import { diffFromText, diffFromToolCall } from './native-chat-diff'

describe('diffFromToolCall', () => {
  it('returns null for non-edit tools', () => {
    expect(diffFromToolCall('Bash', { command: 'ls' })).toBeNull()
  })

  it('builds del/add lines from old_string/new_string', () => {
    const diff = diffFromToolCall('Edit', {
      file_path: '/app.ts',
      old_string: 'a\nb',
      new_string: 'a\nc'
    })
    expect(diff).toEqual([
      { kind: 'meta', text: '/app.ts' },
      { kind: 'del', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'a' },
      { kind: 'add', text: 'c' }
    ])
  })

  it('reads Write content as adds', () => {
    const diff = diffFromToolCall('Write', { path: '/new.ts', content: 'line1\nline2' })
    expect(diff).toEqual([
      { kind: 'meta', text: '/new.ts' },
      { kind: 'add', text: 'line1' },
      { kind: 'add', text: 'line2' }
    ])
  })

  it('returns null when there is no old/new payload', () => {
    expect(diffFromToolCall('Edit', { file_path: '/x' })).toBeNull()
  })
})

describe('diffFromText', () => {
  it('parses unified-diff text into coloured lines', () => {
    const diff = diffFromText('@@ -1,2 +1,2 @@\n context\n-old\n+new')
    expect(diff).toEqual([
      { kind: 'meta', text: '@@ -1,2 +1,2 @@' },
      { kind: 'context', text: ' context' },
      { kind: 'del', text: 'old' },
      { kind: 'add', text: 'new' }
    ])
  })

  it('returns null when there is not enough diff signal', () => {
    expect(diffFromText('just a sentence with - a dash')).toBeNull()
    expect(diffFromText('+only one add line')).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(diffFromText('')).toBeNull()
  })

  it('ignores +++/--- file headers as add/del', () => {
    const diff = diffFromText('--- a/x\n+++ b/x\n-old\n+new')
    expect(diff?.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual(['new'])
    expect(diff?.filter((l) => l.kind === 'del').map((l) => l.text)).toEqual(['old'])
  })

  it('treats a removed line whose content starts with -- as a deletion', () => {
    const diff = diffFromText(
      '@@ -1,4 +1,1 @@\n SELECT 1;\n--- legacy comment\n-SELECT 2;\n-SELECT 3;'
    )
    expect(diff).toEqual([
      { kind: 'meta', text: '@@ -1,4 +1,1 @@' },
      { kind: 'context', text: ' SELECT 1;' },
      { kind: 'del', text: '-- legacy comment' },
      { kind: 'del', text: 'SELECT 2;' },
      { kind: 'del', text: 'SELECT 3;' }
    ])
  })

  it('treats an added line whose content starts with ++ as an addition', () => {
    const diff = diffFromText('@@ -1,1 +1,3 @@\n ctx\n+++flag\n+normal')
    expect(diff?.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual(['++flag', 'normal'])
  })

  it('classifies a C-style --i deletion inside a hunk', () => {
    const diff = diffFromText('@@ -1,3 +1,2 @@\n int i;\n---i;\n-return i;')
    expect(diff?.filter((l) => l.kind === 'del').map((l) => l.text)).toEqual(['--i;', 'return i;'])
  })

  it('keeps real file headers as meta in full git diff output', () => {
    const diff = diffFromText(
      [
        'diff --git a/a.sql b/a.sql',
        'index 9eff25c..33791bf 100644',
        '--- a/a.sql',
        '+++ b/a.sql',
        '@@ -1,3 +1,2 @@',
        ' SELECT 1;',
        '--- legacy comment',
        ' SELECT 2;'
      ].join('\n')
    )
    expect(diff?.filter((l) => l.kind === 'meta').map((l) => l.text)).toEqual([
      'diff --git a/a.sql b/a.sql',
      'index 9eff25c..33791bf 100644',
      '--- a/a.sql',
      '+++ b/a.sql',
      '@@ -1,3 +1,2 @@'
    ])
    expect(diff?.filter((l) => l.kind === 'del').map((l) => l.text)).toEqual(['-- legacy comment'])
  })

  it('detects the second file headers in a multi-file diff', () => {
    const diff = diffFromText(
      [
        'diff --git a/a.sql b/a.sql',
        '--- a/a.sql',
        '+++ b/a.sql',
        '@@ -1,2 +1,1 @@',
        '--- legacy comment',
        ' SELECT 2;',
        'diff --git a/b.lua b/b.lua',
        '--- a/b.lua',
        '+++ b/b.lua',
        '@@ -1,2 +1,1 @@',
        '--- lua comment',
        ' print(1)'
      ].join('\n')
    )
    expect(diff?.filter((l) => l.kind === 'del').map((l) => l.text)).toEqual([
      '-- legacy comment',
      '-- lua comment'
    ])
  })

  it('renders a single-line change once hunk headers prove it is a diff', () => {
    expect(diffFromText('@@ -1,2 +1,1 @@\n SELECT 1;\n--- legacy comment')).not.toBeNull()
    // Without diff structure the two-marker prose guard still applies.
    expect(diffFromText('-- legacy comment')).toBeNull()
  })

  it('classifies a --- content deletion in header-less agent-tool output', () => {
    const diff = diffFromText('---sql comment\n+new\n-more context')
    expect(diff).toEqual([
      { kind: 'del', text: '--sql comment' },
      { kind: 'add', text: 'new' },
      { kind: 'del', text: 'more context' }
    ])
  })

  it('does not read an adjacent --x / ++y content pair as a file header', () => {
    const diff = diffFromText('@@ -1,2 +1,2 @@\n ctx\n---note\n+++flag')
    expect(diff).toEqual([
      { kind: 'meta', text: '@@ -1,2 +1,2 @@' },
      { kind: 'context', text: ' ctx' },
      { kind: 'del', text: '--note' },
      { kind: 'add', text: '++flag' }
    ])
  })

  it('does not read a spaced -- / ++ content pair inside a hunk as a file header', () => {
    const diff = diffFromText('@@ -1,2 +1,2 @@\n ctx\n--- note\n+++ flag')
    expect(diff).toEqual([
      { kind: 'meta', text: '@@ -1,2 +1,2 @@' },
      { kind: 'context', text: ' ctx' },
      { kind: 'del', text: '-- note' },
      { kind: 'add', text: '++ flag' }
    ])
  })

  it('handles /dev/null headers for an added file', () => {
    const diff = diffFromText('--- /dev/null\n+++ b/x.sql\n+-- new comment\n+SELECT 1;')
    expect(diff?.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual([
      '-- new comment',
      'SELECT 1;'
    ])
    expect(diff?.filter((l) => l.kind === 'del')).toEqual([])
  })

  it('leaves a YAML document separator out of the marker count', () => {
    expect(diffFromText('---\na: 1\n---\nb: 2')).toBeNull()
  })

  it('keeps a Markdown thematic break as meta rather than a deletion', () => {
    const diff = diffFromText('Intro\n-----\n- alpha\n- beta')
    expect(diff).toEqual([
      { kind: 'context', text: 'Intro' },
      { kind: 'meta', text: '-----' },
      { kind: 'del', text: ' alpha' },
      { kind: 'del', text: ' beta' }
    ])
  })

  it('still reads a bare --- inside a hunk as a deletion', () => {
    const diff = diffFromText('@@ -1,3 +1,1 @@\n ctx\n---\n-SELECT 1;')
    expect(diff?.filter((l) => l.kind === 'del').map((l) => l.text)).toEqual(['--', 'SELECT 1;'])
  })
})
