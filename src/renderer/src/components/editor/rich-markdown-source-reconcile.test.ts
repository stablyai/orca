import { describe, expect, it, vi } from 'vitest'
import { reconcileSerializedMarkdown } from './rich-markdown-source-reconcile'
import { serializeRichMarkdownForReconcile } from './rich-markdown-reconcile-serializer'
import { createRichMarkdownHtmlSuperscriptLinkContext } from './rich-markdown-html-superscript-link-context'
import type { RichMarkdownImageResolverContext } from './rich-markdown-image-context'

// A deterministic stand-in for the live editor's canonicalization, covering the
// exact style rewrites #6080 reports. Used both to derive baseCanonical/edited
// and as the injected safety `roundTrip`, so the fake stays self-consistent.
function fakeCanonicalize(md: string): string {
  return md
    .split('\n')
    .map((line) => line.replace(/^(\s*)\* /, '$1- ')) // `* bullet` -> `- bullet`
    .join('\n')
    .replace(/__([^_]+)__/g, '**$1**') // `__strong__` -> `**strong**` (before emphasis)
    .replace(/_([^_]+)_/g, '*$1*') // `_emphasis_` -> `*emphasis*`
}

const roundTrip = (md: string): string => fakeCanonicalize(md)

/** Reconcile using the fake canonicalizer for both the base and the safety re-parse. */
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

    // Untouched markup keeps its original bytes.
    expect(reconciled).toContain('_emphasis_')
    expect(reconciled).toContain('__strong__')
    expect(reconciled).toContain('* one')
    expect(reconciled).toContain('* two')
    // The edited region reflects the change.
    expect(reconciled).toContain('# Title!')
    // Never re-canonicalized.
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

    expect(reconciled).toContain('_old_') // original preserved
    expect(reconciled).toContain('*new*') // new content stays canonical
  })

  it('returns edited when the source is already canonical (branch 2)', () => {
    const originalSource = '*word* here\n'
    const edited = '*word* there\n'

    // baseCanonical === originalSource, so there is nothing to preserve.
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

    // Exact bytes, including trailing newline — zero disk churn.
    expect(reconciled).toBe(originalSource)
  })

  it('falls back to canonical when either string exceeds the size cap (branch 3)', () => {
    const big = 'line of text\n'.repeat(9000) // ~117 KB, above the size cap
    const originalSource = `${big}_x_\n`
    const edited = `${big}*x* y\n`

    // Non-canonical source + real semantic change, but oversize → canonical fallback.
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
      // The 10ms budget expires almost immediately; the dependency's default
      // one-second budget takes ~102 reads with this deterministic clock.
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
      // The dependency reads the clock when diffing; zero reads proves the
      // repetitive-input preflight returned before its unbounded half-match scan.
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
      // Simulates a fuzzy misplacement whose render differs from `edited`.
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

    // Simulate the commit helper advancing the refs: originalSource := reconciled1,
    // baseCanonical := edited1. The second edit must still preserve the markup.
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
    // The common case: file is already canonical but ends in \n, so getMarkdown
    // (which strips the trailing newline) never equals it byte-for-byte. This
    // must NOT pay the expensive re-parse — the whole point of branch 2.
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
    // Edit applied, and the source's trailing newline is preserved.
    expect(reconciled).toBe('# Title!\n\n*word*\n\n- one\n- two\n')
  })

  it('preserves CRLF + trailing newline for a canonical CRLF file without re-parsing (branch 2)', () => {
    const originalSource = '# H\r\n\r\n*word*\r\n'
    const baseCanonical = '# H\n\n*word*' // getMarkdown: LF, no trailing
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
    // No mixed endings.
    expect(reconciled.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('restores CRLF on the oversize fallback so a uniform-CRLF file never flips to LF (branch 3)', () => {
    const big = 'line of text\r\n'.repeat(9000) // ~130 KB, above the cap, all CRLF
    const originalSource = `${big}_x_\r\n` // non-canonical emphasis, oversize
    const editedLf = `${big.replace(/\r\n/g, '\n')}*x* y\n`

    const reconciled = reconcileSerializedMarkdown({
      originalSource,
      baseCanonical: `${big.replace(/\r\n/g, '\n')}*x*\n`,
      edited: editedLf,
      roundTrip: () => null
    })

    // Canonical fallback content, but the source's CRLF endings are kept.
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

    // Falls back to canonical content, but in the source's CRLF ending.
    expect(reconciled).toBe('The quick brown fox LEAPS over the lazy dog.\r\n')
  })

  it('preserves CRLF endings on disk without mixing (branch 4 EOL restore)', () => {
    const originalSource = '# H\r\n\r\n_word_\r\n\r\n* one\r\n'
    // getMarkdown always emits LF, so base/edited are LF.
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
    // No mixed endings: stripping CRLF leaves no lone LF.
    expect(reconciled.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('lands a repeated-substring edit on the correct occurrence or falls back', () => {
    const originalSource = ['- _alpha_', '- _beta_', '', '- _alpha_', '- _beta_', ''].join('\n')
    const baseCanonical = fakeCanonicalize(originalSource)
    // Edit only the FIRST "alpha".
    const edited = baseCanonical.replace('*alpha*', '*alpha edited*')

    const reconciled = reconcileWithFake(originalSource, edited)

    // Invariant: the reconciled bytes render exactly to `edited` — the change is
    // never silently relocated to the wrong occurrence or dropped.
    expect(fakeCanonicalize(reconciled).trimEnd()).toBe(edited.trimEnd())
    // Either the source-preserving path landed it, or it cleanly fell back.
    const landedInStyle =
      reconciled.includes('_alpha edited_') && reconciled.split('_beta_').length === 3
    expect(landedInStyle || reconciled === edited).toBe(true)
  })

  it('reconciles a multi-byte edit without throwing "Failed to determine byte offset" (#9492)', () => {
    // Regression: dmp's byte/char index mixup crashes when the patch seed lands mid multi-byte run.
    // Build a mostly-Chinese doc with non-canonical `_`/`*` markers and edit a position that
    // previously threw; every such edit must reconcile and stay render-equal to `edited`.
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

      // Never throws or falls back to a whole-document canonical rewrite.
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
    // `3. ` immediately before a heading parses as an empty list item; without the
    // normalize step the safety re-parse would spuriously mismatch and no-op.
    const doc = '3. \n# Heading\n'
    const once = serialize(doc)
    expect(once).not.toBeNull()
    // Idempotent: re-serializing the output is stable (the live editor's steady state).
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

    expect(reconciled).toContain('_emphasis_') // original style preserved
    expect(reconciled).toContain('# Title!') // edit applied
    // Safety invariant: reconciled renders exactly to the editor's canonical output.
    expect(serialize(reconciled)!.trimEnd()).toBe(edited.trimEnd())
  })

  it('minimizes the diff for the exact #6080 repro (real serializer)', () => {
    // The reported case: a 1-char H1 edit must not rewrite untouched markup.
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

    // Every untouched non-canonical construct keeps its original bytes.
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
    // The edit landed, and nothing else was re-canonicalized.
    expect(reconciled).toContain('# Title!')
    expect(reconciled).not.toContain('*emphasis*')
    expect(reconciled).not.toContain('- one')
    // Safety invariant: reconciled renders exactly to the editor's canonical output.
    expect(serialize(reconciled)!.trimEnd()).toBe(edited.trimEnd())
  })

  it('branch-2 fast path output still renders to the canonical edit (real serializer)', () => {
    // Guards the re-parse-skipping fast path: even though branch 2 does NOT run
    // the safety re-parse, its output must satisfy the same invariant the full
    // path proves — reconciled renders exactly to the editor's canonical output.
    const originalSource = '# Title\n\n*emphasis* text\n\n- one\n- two\n' // canonical + trailing \n
    const baseCanonical = serialize(originalSource)!
    expect(originalSource).not.toBe(baseCanonical) // differs only by the trailing \n
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

    expect(roundTripCalls).toBe(0) // took the cheap path
    expect(reconciled).toBe('# Title!\n\n*emphasis* text\n\n- one\n- two\n')
    expect(serialize(reconciled)!.trimEnd()).toBe(edited.trimEnd())
  })

  it('does not drop a user-added trailing empty paragraph (branch 2 edited-side guard)', () => {
    // getMarkdown keeps `\n\n` for a real trailing empty paragraph, so the fast
    // path must NOT strip it: a canonical doc with a single trailing newline
    // (branch-2 eligible on the source side) edited to add a trailing empty
    // paragraph must persist that block, not silently drop it on save.
    const originalSource = '# H\n\ntext\n'
    const baseCanonical = serialize(originalSource)! // '# H\n\ntext'
    const edited = '# H\n\ntext\n\n' // user pressed Enter at EOF
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

    expect(roundTripCalls).toBeGreaterThan(0) // deferred to the safety-verified path
    // Exact reload equality (NOT trimEnd): the empty paragraph survives.
    expect(serialize(reconciled)).toBe(serialize(edited))
  })

  it('does not introduce a spurious &nbsp; when a trailing-blank-line doc is edited (branch 2 guard)', () => {
    // A canonical heading-ending doc with 3 trailing blank lines: the fast path
    // must NOT preserve that long trailing run while skipping the re-parse, or a
    // reload materializes a literal &nbsp; paragraph (a content change). The
    // >1-trailing-newline guard defers this to the safety-checked path.
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

    expect(roundTripCalls).toBeGreaterThan(0) // took the safety-verified path
    expect(reconciled).not.toContain('&nbsp;')
    // Safety invariant: reconciled renders exactly to the editor's canonical edit.
    expect(serialize(reconciled)!.trimEnd()).toBe(edited.trimEnd())
  })

  it('falls back cleanly when an empty-list doc cannot be source-preserved', () => {
    // Combines an empty list item with non-canonical emphasis; whatever the fuzzy
    // patch does, the output must render to `edited` (no corruption).
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
