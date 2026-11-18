import { describe, expect, it } from 'vitest'
import { normalizeWorkspaceLabels, validateWorkspaceLabelName } from './workspace-labels'

describe('normalizeWorkspaceLabels', () => {
  it('keeps valid labels and drops invalid or duplicate entries', () => {
    expect(
      normalizeWorkspaceLabels([
        { id: 'a', name: ' backend ', color: '#22C55E' },
        { id: 'b', name: 'Short', color: 'f00' },
        { id: 'a', name: 'same id', color: '#22c55e' },
        { id: 'c', name: 'BACKEND', color: '#22c55e' },
        { id: 'd', name: '   ', color: '#22c55e' },
        { id: 'e', name: 'x'.repeat(33), color: '#22c55e' },
        { id: 'f', name: 'bad color', color: 'green' },
        { id: '', name: 'no id', color: '#22c55e' },
        null,
        'label'
      ])
    ).toEqual([
      { id: 'a', name: 'backend', color: '#22c55e' },
      { id: 'b', name: 'Short', color: '#ff0000' }
    ])
  })

  it('returns an empty list for a missing value', () => {
    expect(normalizeWorkspaceLabels(undefined)).toEqual([])
  })
})

describe('validateWorkspaceLabelName', () => {
  const existing = [{ id: 'a', name: 'backend', color: '#22c55e' }]

  it('reports empty, too long and taken names', () => {
    expect(validateWorkspaceLabelName('  ', existing)).toBe('empty')
    expect(validateWorkspaceLabelName('x'.repeat(33), existing)).toBe('too-long')
    expect(validateWorkspaceLabelName(' Backend ', existing)).toBe('taken')
    expect(validateWorkspaceLabelName('frontend', existing)).toBeNull()
  })
})
