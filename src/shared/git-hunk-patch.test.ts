import { describe, expect, it } from 'vitest'
import { buildHunkPatch, parseFileDiff, patchTouchesOnlyPath } from './git-hunk-patch'

const TWO_HUNK = [
  'diff --git a/foo.ts b/foo.ts',
  'index 83db48f..f735c2d 100644',
  '--- a/foo.ts',
  '+++ b/foo.ts',
  '@@ -1,3 +1,4 @@',
  ' line1',
  '+added',
  ' line2',
  ' line3',
  '@@ -10,2 +11,3 @@ ctx',
  ' x',
  '+y',
  ' z',
  ''
].join('\n')

describe('parseFileDiff', () => {
  it('splits header from hunks and reads @@ ranges', () => {
    const parsed = parseFileDiff(TWO_HUNK)
    expect(parsed.headerLines).toEqual([
      'diff --git a/foo.ts b/foo.ts',
      'index 83db48f..f735c2d 100644',
      '--- a/foo.ts',
      '+++ b/foo.ts'
    ])
    expect(parsed.hunks).toHaveLength(2)
    expect(parsed.hunks[0]).toMatchObject({
      index: 0,
      header: '@@ -1,3 +1,4 @@',
      oldStart: 1,
      oldLineCount: 3,
      newStart: 1,
      newLineCount: 4
    })
    expect(parsed.hunks[1]).toMatchObject({ index: 1, newStart: 11, newLineCount: 3 })
    expect(parsed.isBinary).toBe(false)
  })

  it('defaults an omitted line count to 1', () => {
    const parsed = parseFileDiff(['--- a/x', '+++ b/x', '@@ -5 +5,2 @@', ' a', '+b', ''].join('\n'))
    expect(parsed.hunks[0]).toMatchObject({
      oldStart: 5,
      oldLineCount: 1,
      newStart: 5,
      newLineCount: 2
    })
  })

  it('flags binary diffs and yields no hunks', () => {
    const parsed = parseFileDiff(
      [
        'diff --git a/logo.png b/logo.png',
        'index aaa..bbb 100644',
        'Binary files a/logo.png and b/logo.png differ',
        ''
      ].join('\n')
    )
    expect(parsed.isBinary).toBe(true)
    expect(parsed.hunks).toHaveLength(0)
  })

  it('parses a new file as a single hunk anchored at line 1', () => {
    const parsed = parseFileDiff(
      [
        'diff --git a/new.ts b/new.ts',
        'new file mode 100644',
        'index 0000000..abc1234',
        '--- /dev/null',
        '+++ b/new.ts',
        '@@ -0,0 +1,2 @@',
        '+a',
        '+b',
        ''
      ].join('\n')
    )
    expect(parsed.hunks).toHaveLength(1)
    expect(parsed.hunks[0]).toMatchObject({
      oldStart: 0,
      oldLineCount: 0,
      newStart: 1,
      newLineCount: 2
    })
  })

  it('keeps the "\\ No newline at end of file" marker inside its hunk', () => {
    const parsed = parseFileDiff(
      [
        '--- a/x',
        '+++ b/x',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '\\ No newline at end of file',
        ''
      ].join('\n')
    )
    expect(parsed.hunks[0].lines).toEqual(['-old', '+new', '\\ No newline at end of file'])
  })

  it('treats a bare empty body line as a blank context line of the hunk', () => {
    const parsed = parseFileDiff(
      ['--- a/x', '+++ b/x', '@@ -1,2 +1,3 @@', ' a', '', '+b', ''].join('\n')
    )
    expect(parsed.hunks).toHaveLength(1)
    expect(parsed.hunks[0].lines).toEqual([' a', '', '+b'])
  })

  it('returns an empty result for empty input', () => {
    expect(parseFileDiff('')).toEqual({ headerLines: [], hunks: [], isBinary: false })
  })
})

describe('buildHunkPatch', () => {
  it('emits the header plus only the selected hunk', () => {
    const parsed = parseFileDiff(TWO_HUNK)
    expect(buildHunkPatch(parsed, [1])).toBe(
      [
        'diff --git a/foo.ts b/foo.ts',
        'index 83db48f..f735c2d 100644',
        '--- a/foo.ts',
        '+++ b/foo.ts',
        '@@ -10,2 +11,3 @@ ctx',
        ' x',
        '+y',
        ' z',
        ''
      ].join('\n')
    )
  })

  it('round-trips the original bytes when every hunk is selected', () => {
    const parsed = parseFileDiff(TWO_HUNK)
    expect(buildHunkPatch(parsed, [0, 1])).toBe(TWO_HUNK)
  })

  it('preserves CRLF content lines through a round-trip', () => {
    const crlf = ['--- a/x', '+++ b/x', '@@ -1 +1 @@', '-old\r', '+new\r', ''].join('\n')
    const parsed = parseFileDiff(crlf)
    expect(buildHunkPatch(parsed, [0])).toBe(crlf)
  })

  it('returns empty string for an empty selection or a headerless diff', () => {
    const parsed = parseFileDiff(TWO_HUNK)
    expect(buildHunkPatch(parsed, [])).toBe('')
    expect(buildHunkPatch({ headerLines: [], hunks: parsed.hunks, isBinary: false }, [0])).toBe('')
  })
})

describe('patchTouchesOnlyPath', () => {
  it('accepts a patch whose only path matches', () => {
    expect(patchTouchesOnlyPath(TWO_HUNK, 'foo.ts')).toBe(true)
  })

  it('rejects a patch that targets a different path', () => {
    expect(patchTouchesOnlyPath(TWO_HUNK, 'bar.ts')).toBe(false)
  })

  it('rejects an empty / header-less patch', () => {
    expect(patchTouchesOnlyPath('', 'foo.ts')).toBe(false)
  })

  it('normalizes backslashes in the expected path', () => {
    const patch = ['diff --git a/dir/x.ts b/dir/x.ts', '--- a/dir/x.ts', '+++ b/dir/x.ts', ''].join(
      '\n'
    )
    expect(patchTouchesOnlyPath(patch, 'dir\\x.ts')).toBe(true)
  })

  // git leaves spaces literal and (with core.quotePath=false) non-ASCII literal.
  it.each(['my file.ts', 'café.ts'])('accepts the unquoted path %s', (name) => {
    const patch = [`diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`, ''].join(
      '\n'
    )
    expect(patchTouchesOnlyPath(patch, name)).toBe(true)
  })
})
