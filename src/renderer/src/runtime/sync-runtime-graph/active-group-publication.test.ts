import { describe, expect, it } from 'vitest'
import { changedActiveGroups } from './active-group-publication'

describe('the active groups a graph publication carries', () => {
  it('names only the workspaces whose group changed', () => {
    expect(changedActiveGroups({ a: 'g1', b: 'g3' }, { a: 'g1', b: 'g2' })).toEqual({ b: 'g3' })
  })

  it('names a workspace that no longer shows a group as none', () => {
    expect(changedActiveGroups({}, { a: 'g1' })).toEqual({ a: null })
  })

  it('carries nothing when nothing changed', () => {
    expect(changedActiveGroups({ a: 'g1' }, { a: 'g1' })).toBeUndefined()
  })
})
