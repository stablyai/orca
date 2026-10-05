import { describe, expect, it } from 'vitest'
import {
  createEditorRecoveryTextPatch,
  editorRecoveryTextPatchSchema,
  replayEditorRecoveryTextPatches,
  type EditorRecoveryTextPatch
} from './editor-recovery-text-patch'

const padding = 'abc\r\n'.repeat(1_000)
describe('incremental recovery text', () => {
  it.each([
    ['\ud800', '😀'],
    ['😀', '\ud800'],
    ['😀', '😁'],
    ['\udc00', '😀'],
    ['😀', '\udc00'],
    ['\ud800x', '\ud800\udc00x'],
    ['\0\r\n', '\0\n'],
    ['', '\ud800'],
    ['\ud800', '']
  ])('preserves exact code units and byte counts for %j → %j', (before, after) => {
    const previous = padding + before + padding
    const content = padding + after + padding
    const patch = createEditorRecoveryTextPatch(previous, content)
    expect(patch).not.toBeNull()
    if (!patch) {
      throw new Error('Expected a small edit')
    }
    expect(replayEditorRecoveryTextPatches(previous, [patch])).toBe(content)
    expect(Buffer.byteLength(previous) + patch.byteLengthDelta).toBe(Buffer.byteLength(content))
  })

  it('replays edits at either end and across earlier inserts without whole-body intermediate copies', () => {
    const original = `${padding}\ud800\0${padding}`
    let content = original
    const patches: EditorRecoveryTextPatch[] = []
    let bytes = Buffer.byteLength(original)
    const alphabet = ['a', '\0', '\r', '\n', '\ud800', '\udc00', '😀']
    for (let index = 0; index < 200; index++) {
      const start =
        index % 3 === 0 ? 0 : index % 3 === 1 ? content.length : (index * 173) % content.length
      const removed = Math.min(index % 5, content.length - start)
      const next =
        content.slice(0, start) + alphabet[index % alphabet.length] + content.slice(start + removed)
      const patch = createEditorRecoveryTextPatch(content, next)
      if (!patch) {
        throw new Error('Expected an incremental edit')
      }
      patches.push(patch)
      bytes += patch.byteLengthDelta
      content = next
      expect(bytes).toBe(Buffer.byteLength(content))
    }
    expect(replayEditorRecoveryTextPatches(original, patches)).toBe(content)
  })

  it('uses snapshots for small drafts, large replacements and major deletions', () => {
    expect(createEditorRecoveryTextPatch('small', 'small edit')).toBeNull()
    expect(createEditorRecoveryTextPatch('a'.repeat(5_000), 'b'.repeat(5_000))).toBeNull()
    expect(createEditorRecoveryTextPatch(padding.repeat(4), padding)).toBeNull()
  })

  it('rejects edits outside their acknowledged base', () => {
    const patch = { baseLength: 3, start: 2, removed: 2, inserted: '', byteLengthDelta: -2 }
    expect(editorRecoveryTextPatchSchema.safeParse(patch).success).toBe(false)
    expect(() => replayEditorRecoveryTextPatches('abc', [patch])).toThrow('does not match')
    expect(() => replayEditorRecoveryTextPatches('abcd', [{ ...patch, removed: 0 }])).toThrow(
      'does not match'
    )
  })
})
