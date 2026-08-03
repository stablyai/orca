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

  it('counts a removed line whose content begins with -- (--- prefix collision)', () => {
    // A deleted SQL/Lua/Haskell `-- comment` is emitted by git as `---<content>`,
    // which must be classified as a deletion, not mistaken for the `--- a/file` header.
    const diff = diffFromText('@@ -1,2 +1,2 @@\n ctx\n---sql comment\n+new')
    expect(diff).toEqual([
      { kind: 'meta', text: '@@ -1,2 +1,2 @@' },
      { kind: 'context', text: ' ctx' },
      { kind: 'del', text: '--sql comment' },
      { kind: 'add', text: 'new' }
    ])
  })

  it('counts an added line whose content begins with ++ (+++ prefix collision)', () => {
    const diff = diffFromText('@@ -1,2 +1,2 @@\n ctx\n-old\n+++flag')
    expect(diff).toEqual([
      { kind: 'meta', text: '@@ -1,2 +1,2 @@' },
      { kind: 'context', text: ' ctx' },
      { kind: 'del', text: 'old' },
      { kind: 'add', text: '++flag' }
    ])
  })

  it('counts a --- content deletion in a header-less agent-tool diff (no @@)', () => {
    // Agent-tool output may carry no `@@` hunk header; the pair rule (unlike countDiffLines'
    // hunk-state fix) must still classify `---<content>` as a deletion here.
    const diff = diffFromText('---sql comment\n+new\n-more context')
    expect(diff).toEqual([
      { kind: 'del', text: '--sql comment' },
      { kind: 'add', text: 'new' },
      { kind: 'del', text: 'more context' }
    ])
  })

  it('does not swallow a --x / ++y content pair as a file header', () => {
    // A deletion of `--note` immediately followed by an addition of `++flag` must both
    // count — they are NOT the canonical `--- <old>` / `+++ <new>` header pair (no space).
    const diff = diffFromText('@@ -1,2 +1,2 @@\n ctx\n---note\n+++flag')
    expect(diff).toEqual([
      { kind: 'meta', text: '@@ -1,2 +1,2 @@' },
      { kind: 'context', text: ' ctx' },
      { kind: 'del', text: '--note' },
      { kind: 'add', text: '++flag' }
    ])
  })
})
