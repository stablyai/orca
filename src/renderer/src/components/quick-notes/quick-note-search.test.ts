import { describe, expect, it } from 'vitest'
import { searchQuickNotes } from './quick-note-search'
import type { QuickNote } from '../../../../shared/quick-note-types'

const notes: QuickNote[] = [
  { id: '1', label: 'Email signature', body: 'Best regards' },
  { id: '2', label: 'Deploy block', body: 'kubectl rollout status' },
  { id: '3', label: 'PR template', body: 'signature verification steps' }
]

describe('searchQuickNotes', () => {
  it('returns all notes for an empty query', () => {
    expect(searchQuickNotes(notes, '  ')).toEqual(notes)
  })

  it('matches on label and body, ranking label matches first', () => {
    const result = searchQuickNotes(notes, 'signature')
    expect(result.map((n) => n.id)).toEqual(['1', '3'])
  })

  it('is case-insensitive', () => {
    expect(searchQuickNotes(notes, 'DEPLOY').map((n) => n.id)).toEqual(['2'])
  })

  it('returns [] when nothing matches', () => {
    expect(searchQuickNotes(notes, 'zzz')).toEqual([])
  })
})
