import { describe, expect, it, vi } from 'vitest'
import { reconcileSerializedMarkdown } from './rich-markdown-source-reconcile'
import { serializeRichMarkdownForReconcile } from './rich-markdown-reconcile-serializer'
import { createRichMarkdownHtmlSuperscriptLinkContext } from './rich-markdown-html-superscript-link-context'
import type { RichMarkdownImageResolverContext } from './rich-markdown-image-context'

// Use one deterministic style canonicalizer for base/edited text and the safety reparse so the fake stays self-consistent.
function fakeCanonicalize(md: string): string {
  return md
    .split('\n')
    .map((line) => line.replace(/^(\s*)\* /, '$1- '))
    .join('\n')
    .replace(/__([^_]+)__/g, '**$1**')
    .replace(/_([^_]+)_/g, '*$1*')
}

const roundTrip = (md: string): string => fakeCanonicalize(md)

function reconcileWithFake(originalSource: string, edited: string): string {
  return reconcileSerializedMarkdown({
    originalSource,
    baseCanonical: fakeCanonicalize(originalSource),
    edited,
    roundTrip
  })
}

describe('reconcileSerializedMarkdown', () => {
  it('preserves untouched non-canonical regions on a 1-char edit', () => {
    const originalSource = '# Title\n\n_emphasis_ and __strong__\n\n* one\n* two\n'
    const baseCanonical = fakeCanonicalize(originalSource)
    const edited = baseCanonical.replace('# Title', '# Title!')

    const reconciled = reconcileWithFake(originalSource, edited)

    expect(reconciled).toContain('_emphasis_')
    expect(reconciled).toContain('__strong__')
    expect(reconciled).toContain('* one')
    expect(reconciled).toContain('* two')
    expect(reconciled).toContain('# Title!')
    expect(reconciled).not.toContain('*emphasis*')
    expect(reconciled).not.toContain('- one')
  })

  it('preserves the trailing newline of the original source', () => {
    const originalSource = '# H\n\n_word_\n'
    const edited = fakeCanonicalize(originalSource).replace('# H', '# H!')

    const reconciled = reconcileWithFake(originalSource, edited)

    expect(reconciled.endsWith('\n')).toBe(true)
    expect(reconciled).toContain('_word_')
  })

  it('keeps newly-typed content canonical while preserving the original style', () => {
    const originalSource = '_old_\n'
    const edited = '*old* and *new*\n'

    const reconciled = reconcileWithFake(originalSource, edited)

    expect(reconciled).toContain('_old_')
    expect(reconciled).toContain('*new*')
  })

  it('returns edited when the source is already canonical (branch 2)', () => {
    const originalSource = '*word* here\n'
    const edited = '*word* there\n'

    expect(reconcileWithFake(originalSource, edited)).toBe(edited)
  })

  it('returns the source verbatim when there is no semantic change (branch 1)', () => {
    const originalSource = '_word_ and * bullet\n'
    const baseCanonical = fakeCanonicalize(originalSource)

    // edited === baseCanonical: e.g. cursor moved, selection changed, no edit.
    const reconciled = reconcileSerializedMarkdown({
      originalSource,
      baseCanonical,
      edited: baseCanonical,
      roundTrip
    })

    expect(reconciled).toBe(originalSource)
  })

  it('falls back to canonical when either string exceeds the size cap (branch 3)', () => {
    const big = 'line of text\n'.repeat(9000)
    const originalSource = `${big}_x_\n`
    const edited = `${big}*x* y\n`

    expect(reconcileWithFake(originalSource, edited)).toBe(edited)
  })

  it('bounds diff work for replacement-heavy edits instead of using the 1s library default', () => {
    let now = 0
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 10
      return now
    })
    const baseCanonical = 'a'.repeat(20_000)
    const edited = 'b'.repeat(20_000)

    try {
      const reconciled = reconcileSerializedMarkdown({
        originalSource: `_${baseCanonical.slice(1)}`,
        baseCanonical,
        edited,
        roundTrip: (markdown) => markdown
      })

      expect(reconciled).toBe(edited)
      // The deterministic clock distinguishes the 10 ms budget from the dependency’s one-second default.
      expect(dateNow.mock.calls.length).toBeLessThan(10)
    } finally {
      dateNow.mockRestore()
    }
  })

  it('skips the dependency half-match path when its long seed repeats', () => {
    const dateNow = vi.spyOn(Date, 'now')
    const baseCanonical = 'ab'.repeat(24_500)
    const edited = 'ba'.repeat(24_500)

    try {
      const reconciled = reconcileSerializedMarkdown({
        originalSource: `_${baseCanonical.slice(1)}`,
        baseCanonical,
        edited,
        roundTrip: (markdown) => markdown
      })

      expect(reconciled).toBe(edited)
      // Zero clock reads proves preflight avoided the dependency’s unbounded repeated-seed half-match scan.
      expect(dateNow).not.toHaveBeenCalled()
    } finally {
      dateNow.mockRestore()
    }
  })

  it('still preserves a small edit inside a highly repetitive document', () => {
    const dateNow = vi.spyOn(Date, 'now')
    const baseCanonical = 'ab'.repeat(24_500)
    const editIndex = Math.floor(baseCanonical.length / 2)
    const edited = `${baseCanonical.slice(0, editIndex)}X${baseCanonical.slice(editIndex + 1)}`

    try {
      const reconciled = reconcileSerializedMarkdown({
        originalSource: `_${baseCanonical.slice(1)}`,
        baseCanonical,
        edited,
        roundTrip: (markdown) => `a${markdown.slice(1)}`
      })

      expect(reconciled).toBe(`_${edited.slice(1)}`)
      expect(dateNow).toHaveBeenCalled()
    } finally {
      dateNow.mockRestore()
    }
  })

  it('falls back to canonical when a hunk fails to apply (branch 5)', () => {
    const baseCanonical = 'The quick brown fox jumps over the lazy dog every morning.\n'
    const edited = 'The quick brown fox LEAPS over the lazy dog every morning.\n'
    const originalSource = 'Zzz totally unrelated content sharing nothing at all here.\n'

    const reconciled = reconcileSerializedMarkdown({
      originalSource,
      baseCanonical,
      edited,
      roundTrip
    })

    expect(reconciled).toBe(edited)
  })

  it('falls back to canonical when the safety re-parse mismatches (branch 6)', () => {
    const reconciled = reconcileSerializedMarkdown({
      originalSource: '_a_\n',
      baseCanonical: '*a*\n',
      edited: '*a* b\n',
      roundTrip: () => 'something entirely different'
    })

    expect(reconciled).toBe('*a* b\n')
  })

  it('falls back to canonical when the safety serializer returns null (branch 6)', () => {
    const reconciled = reconcileSerializedMarkdown({
      originalSource: '_a_\n',
      baseCanonical: '*a*\n',
      edited: '*a* b\n',
      roundTrip: () => null
    })

    expect(reconciled).toBe('*a* b\n')
  })

  it('preserves non-canonical regions across an incremental two-edit ref chain', () => {
    const originalSource = '# Title\n\n_emphasis_\n\n* item\n'
    const base = fakeCanonicalize(originalSource)
    const edited1 = base.replace('# Title', '# Title A')

    const reconciled1 = reconcileWithFake(originalSource, edited1)
    expect(reconciled1).toContain('_emphasis_')
    expect(reconciled1).toContain('* item')

    // Advance source/canonical refs as commit does; later edits must still preserve original markup.
    const edited2 = edited1.replace('# Title A', '# Title AB')
    const reconciled2 = reconcileSerializedMarkdown({
      originalSource: reconciled1,
      baseCanonical: edited1,
      edited: edited2,
      roundTrip
    })

    expect(reconciled2).toContain('_emphasis_')
    expect(reconciled2).toContain('* item')
    expect(reconciled2).toContain('# Title AB')
  })

  it('skips the safety re-parse for a canonical LF file with a trailing newline (branch 2)', () => {
    // Canonical sources with one trailing newline should preserve it without paying for a safety reparse.
    const originalSource = '# Title\n\n*word*\n\n- one\n- two\n'
    const baseCanonical = '# Title\n\n*word*\n\n- one\n- two' // getMarkdown: no trailing \n
    const edited = '# Title!\n\n*word*\n\n- one\n- two'
    const roundTrip = vi.fn(() => edited)

    const reconciled = reconcileSerializedMarkdown({
      originalSource,
      baseCanonical,
      edited,
      roundTrip
    })

    expect(roundTrip).not.toHaveBeenCalled()
    expect(reconciled).toBe('# Title!\n\n*word*\n\n- one\n- two\n')
  })

  it('preserves CRLF + trailing newline for a canonical CRLF file without re-parsing (branch 2)', () => {
    const originalSource = '# H\r\n\r\n*word*\r\n'
    const baseCanonical = '# H\n\n*word*'
    const edited = '# H!\n\n*word*'
    const roundTrip = vi.fn(() => edited)

    const reconciled = reconcileSerializedMarkdown({
      originalSource,
      baseCanonical,
      edited,
      roundTrip
    })

    expect(roundTrip).not.toHaveBeenCalled()
    expect(reconciled).toBe('# H!\r\n\r\n*word*\r\n')
    expect(reconciled.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('restores CRLF on the oversize fallback so a uniform-CRLF file never flips to LF (branch 3)', () => {
    const big = 'line of text\r\n'.repeat(9000)
    const originalSource = `${big}_x_\r\n`
    const editedLf = `${big.replace(/\r\n/g, '\n')}*x* y\n`

    const reconciled = reconcileSerializedMarkdown({
      originalSource,
      baseCanonical: `${big.replace(/\r\n/g, '\n')}*x*\n`,
      edited: editedLf,
      roundTrip: () => null
    })

    expect(reconciled).toContain('\r\n')
    expect(reconciled.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('restores CRLF on the hunk-apply fallback (branch 5)', () => {
    const originalSource = 'Zzz unrelated content sharing nothing here.\r\n'
    const baseCanonical = 'The quick brown fox jumps over the lazy dog.\n'
    const edited = 'The quick brown fox LEAPS over the lazy dog.\n'

    const reconciled = reconcileSerializedMarkdown({
      originalSource,
      baseCanonical,
      edited,
      roundTrip
    })

    expect(reconciled).toBe('The quick brown fox LEAPS over the lazy dog.\r\n')
  })

  it('preserves CRLF endings on disk without mixing (branch 4 EOL restore)', () => {
    const originalSource = '# H\r\n\r\n_word_\r\n\r\n* one\r\n'
    const baseCanonical = '# H\n\n*word*\n\n- one\n'
    const edited = '# H!\n\n*word*\n\n- one\n'

    const reconciled = reconcileSerializedMarkdown({
      originalSource,
      baseCanonical,
      edited,
      roundTrip
    })

    expect(reconciled).toContain('\r\n')
    expect(reconciled).toContain('_word_')
    expect(reconciled).toContain('# H!')
    expect(reconciled.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('lands a repeated-substring edit on the correct occurrence or falls back', () => {
    const originalSource = ['- _alpha_', '- _beta_', '', '- _alpha_', '- _beta_', ''].join('\n')
    const baseCanonical = fakeCanonicalize(originalSource)
    const edited = baseCanonical.replace('*alpha*', '*alpha edited*')

    const reconciled = reconcileWithFake(originalSource, edited)

    // Prove edits cannot move to another repeated occurrence or disappear during fuzzy patching.
    expect(fakeCanonicalize(reconciled).trimEnd()).toBe(edited.trimEnd())
    const landedInStyle =
      reconciled.includes('_alpha edited_') && reconciled.split('_beta_').length === 3
    expect(landedInStyle || reconciled === edited).toBe(true)
  })

  it('reconciles a multi-byte edit without throwing "Failed to determine byte offset" (#9492)', () => {
    // Regression: byte/code-unit confusion crashed patch seeds in multibyte text; every sampled edit must stay render-equivalent.
    const lines: string[] = []
    for (let i = 0; i < 20; i++) {
      lines.push(`_强调${i}_ 😀 café 这是一段包含很多中文字符的文本内容用来测试多字节偏移问题`)
    }
    const originalSource = `# 标题\n\n${lines.join('\n')}\n`
    const baseCanonical = fakeCanonicalize(originalSource)

    // Sweep insert positions so we exercise the offsets that used to overshoot the byte target.
    const chars = [...baseCanonical]
    for (let pos = 5; pos < chars.length - 5; pos += 3) {
      const inserted = ['插', '😀', 'é'][Math.floor(pos / 3) % 3]
      const edited = `${chars.slice(0, pos).join('')}${inserted}${chars.slice(pos).join('')}`

      const reconciled = reconcileWithFake(originalSource, edited)

      expect(reconciled).not.toBe(edited)
      expect(fakeCanonicalize(reconciled).trimEnd()).toBe(edited.trimEnd())
    }
  })

  it('keeps later multi-hunk seeds in the rolling application coordinate space', () => {
    const lines = Array.from({ length: 8 }, (_, i) => `_强调${i}_ ascii segment ${i} 中文 tail`)
    const originalSource = `# 标题\n\n${lines.join('\n')}\n`
    const baseCanonical = fakeCanonicalize(originalSource)
    // Why: the first hunk changes the UTF-8/code-unit delta before the second seed is decoded.
    const edited = baseCanonical
      .replace('segment 1', 'segment 1 🚀🚀')
      .replace('segment 6', 'segment 6 XYZ')

    const reconciled = reconcileWithFake(originalSource, edited)

    expect(reconciled).not.toBe(edited)
    expect(fakeCanonicalize(reconciled)).toBe(edited)
  })
})

describe('serializeRichMarkdownForReconcile (real editor pipeline)', () => {
  const serializerContext = {
    htmlSuperscriptLinkContext: createRichMarkdownHtmlSuperscriptLinkContext({
      sourceFilePath: '',
      worktreeId: '',
      worktreeRoot: null,
      sourceOwner: { kind: 'unknown' as const }
    }),
    imageResolverContext: {
      filePath: '',
      runtimeContext: undefined
    } satisfies RichMarkdownImageResolverContext
  }

  const serialize = (md: string): string | null =>
    serializeRichMarkdownForReconcile(md, serializerContext)

  it('applies normalizeEmptyListItems so empty list items round-trip stably', () => {
    // Normalize paragraph-less empty list items or the safety reparse spuriously mismatches.
    const doc = '3. \n# Heading\n'
    const once = serialize(doc)
    expect(once).not.toBeNull()
    expect(serialize(once!)?.trimEnd()).toBe(once!.trimEnd())
  })

  it('reconciles a non-canonical doc end-to-end with the real serializer, preserving style', () => {
    const originalSource = '# Title\n\n_emphasis_ text\n'
    const baseCanonical = serialize(originalSource)!
    const edited = baseCanonical.replace('# Title', '# Title!')

    const reconciled = reconcileSerializedMarkdown({
      originalSource,
      baseCanonical,
      edited,
      roundTrip: (md) => serialize(md)
    })

    expect(reconciled).toContain('_emphasis_')
    expect(reconciled).toContain('# Title!')
    expect(serialize(reconciled)!.trimEnd()).toBe(edited.trimEnd())
  })

  it('minimizes the diff for the exact #6080 repro (real serializer)', () => {
    const originalSource =
      '# Title\n\n_emphasis_ and __strong__\n\n* one\n* two\n* three\n\n_more emphasis_\n'
    const baseCanonical = serialize(originalSource)!
    const edited = baseCanonical.replace('# Title', '# Title!')

    const reconciled = reconcileSerializedMarkdown({
      originalSource,
      baseCanonical,
      edited,
      roundTrip: (md) => serialize(md)
    })

    for (const preserved of [
      '_emphasis_',
      '__strong__',
      '* one',
      '* two',
      '* three',
      '_more emphasis_'
    ]) {
      expect(reconciled).toContain(preserved)
    }
    expect(reconciled).toContain('# Title!')
    expect(reconciled).not.toContain('*emphasis*')
    expect(reconciled).not.toContain('- one')
    expect(serialize(reconciled)!.trimEnd()).toBe(edited.trimEnd())
  })

  it('branch-2 fast path output still renders to the canonical edit (real serializer)', () => {
    // The fast path skips reparse but must satisfy the same canonical-output invariant.
    const originalSource = '# Title\n\n*emphasis* text\n\n- one\n- two\n'
    const baseCanonical = serialize(originalSource)!
    expect(originalSource).not.toBe(baseCanonical)
    const edited = baseCanonical.replace('# Title', '# Title!')
    let roundTripCalls = 0

    const reconciled = reconcileSerializedMarkdown({
      originalSource,
      baseCanonical,
      edited,
      roundTrip: (md) => {
        roundTripCalls += 1
        return serialize(md)
      }
    })

    expect(roundTripCalls).toBe(0)
    expect(reconciled).toBe('# Title!\n\n*emphasis* text\n\n- one\n- two\n')
    expect(serialize(reconciled)!.trimEnd()).toBe(edited.trimEnd())
  })

  it('does not drop a user-added trailing empty paragraph (branch 2 edited-side guard)', () => {
    // A real trailing empty paragraph is semantic; the fast path must not trim it away.
    const originalSource = '# H\n\ntext\n'
    const baseCanonical = serialize(originalSource)!
    const edited = '# H\n\ntext\n\n'
    let roundTripCalls = 0

    const reconciled = reconcileSerializedMarkdown({
      originalSource,
      baseCanonical,
      edited,
      roundTrip: (md) => {
        roundTripCalls += 1
        return serialize(md)
      }
    })

    expect(roundTripCalls).toBeGreaterThan(0)
    expect(serialize(reconciled)).toBe(serialize(edited))
  })

  it('does not introduce a spurious &nbsp; when a trailing-blank-line doc is edited (branch 2 guard)', () => {
    // Long trailing blank runs need safety checking or reload can introduce a literal &nbsp; paragraph.
    const originalSource = '# Notes\n\nSome text here.\n\n## TODO\n\n\n\n'
    const baseCanonical = serialize(originalSource)!
    const edited = baseCanonical.replace('## TODO', '## TODO\n\nA new note.')
    let roundTripCalls = 0

    const reconciled = reconcileSerializedMarkdown({
      originalSource,
      baseCanonical,
      edited,
      roundTrip: (md) => {
        roundTripCalls += 1
        return serialize(md)
      }
    })

    expect(roundTripCalls).toBeGreaterThan(0)
    expect(reconciled).not.toContain('&nbsp;')
    expect(serialize(reconciled)!.trimEnd()).toBe(edited.trimEnd())
  })

  it('falls back cleanly when an empty-list doc cannot be source-preserved', () => {
    // Empty-list normalization and fuzzy style preservation must still produce the edited document.
    const originalSource = '_lead_\n\n3. \n# Heading\n'
    const baseCanonical = serialize(originalSource)!
    const edited = baseCanonical.replace('Heading', 'Heading!')

    const reconciled = reconcileSerializedMarkdown({
      originalSource,
      baseCanonical,
      edited,
      roundTrip: (md) => serialize(md)
    })

    expect(serialize(reconciled)!.trimEnd()).toBe(edited.trimEnd())
  })
})
