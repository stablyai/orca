import { describe, expect, it } from 'vitest'
import {
  applyQuickNoteMutation,
  MAX_QUICK_NOTES,
  MAX_QUICK_NOTE_BODY_LENGTH,
  MAX_QUICK_NOTE_LABEL_LENGTH,
  normalizeQuickNotes
} from './quick-notes'
import type { QuickNote } from './quick-note-types'

const note = (over: Partial<QuickNote> = {}): QuickNote => ({
  id: 'quick-note-1',
  label: 'Signature',
  body: 'Best,\nFrank',
  ...over
})

describe('normalizeQuickNotes', () => {
  it('returns [] for non-arrays', () => {
    expect(normalizeQuickNotes(undefined)).toEqual([])
    expect(normalizeQuickNotes(null)).toEqual([])
    expect(normalizeQuickNotes('nope')).toEqual([])
  })

  it('drops non-object entries and entries with neither label nor body', () => {
    expect(normalizeQuickNotes([1, 'x', null, {}, { id: 'a' }])).toEqual([])
  })

  it('trims and caps label and body', () => {
    const [out] = normalizeQuickNotes([
      { id: 'a', label: `  ${'x'.repeat(200)}  `, body: `${'y'.repeat(20000)}\n\n` }
    ])
    expect(out.label).toHaveLength(MAX_QUICK_NOTE_LABEL_LENGTH)
    expect(out.body).toHaveLength(MAX_QUICK_NOTE_BODY_LENGTH)
  })

  it('generates ids when missing and dedupes collisions', () => {
    const out = normalizeQuickNotes([
      { label: 'one', body: 'a' },
      { id: 'dup', label: 'two', body: 'b' },
      { id: 'dup', label: 'three', body: 'c' }
    ])
    expect(out.map((n) => n.id)).toEqual(['quick-note-1', 'dup', 'dup-2'])
  })

  it('keeps a half-filled row (label only) so a fresh add is not dropped mid-edit', () => {
    expect(normalizeQuickNotes([{ id: 'a', label: 'Draft' }])).toEqual([
      { id: 'a', label: 'Draft', body: '' }
    ])
  })

  it('caps the list at MAX_QUICK_NOTES', () => {
    const many = Array.from({ length: MAX_QUICK_NOTES + 5 }, (_, i) => ({
      id: `n${i}`,
      label: `n${i}`,
      body: 'x'
    }))
    expect(normalizeQuickNotes(many)).toHaveLength(MAX_QUICK_NOTES)
  })
})

describe('applyQuickNoteMutation', () => {
  it('appends a new note on upsert', () => {
    expect(applyQuickNoteMutation([], { type: 'upsert', note: note() })).toEqual([note()])
  })

  it('replaces an existing note by id on upsert', () => {
    const next = note({ label: 'Renamed' })
    expect(applyQuickNoteMutation([note()], { type: 'upsert', note: next })).toEqual([next])
  })

  it('removes a note on delete', () => {
    expect(applyQuickNoteMutation([note()], { type: 'delete', id: 'quick-note-1' })).toEqual([])
  })
})
