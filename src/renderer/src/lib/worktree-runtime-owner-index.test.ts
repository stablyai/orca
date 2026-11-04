import { describe, expect, it } from 'vitest'
import {
  findIndexedProjectGroupDisplay,
  resolveIndexedProjectGroupOwner
} from './worktree-runtime-owner-index'

describe('raw folder group display and ownership products', () => {
  it.each(['owner-first', 'display-first'])(
    'shares one build in %s order while keeping first display separate from routing',
    (order) => {
      let reads = 0
      const first = {
        get id() {
          reads++
          return 'twin'
        },
        name: 'First',
        executionHostId: 'local'
      }
      const sameHost = { id: 'twin', name: '', executionHostId: 'local' }
      const remote = { id: 'twin', name: 'Remote', executionHostId: 'runtime:server' }
      const nul = { id: 'twin\0local', name: 'Bare NUL', executionHostId: 'local' }
      const rows = [first, sameHost, remote, nul]
      if (order === 'owner-first') {
        resolveIndexedProjectGroupOwner(rows, 'twin')
      } else {
        expect(findIndexedProjectGroupDisplay(rows, 'twin')).toBe(first)
      }
      const built = reads
      expect(built).toBeGreaterThan(0)
      expect(findIndexedProjectGroupDisplay(rows, 'twin')).toBe(first)
      expect(findIndexedProjectGroupDisplay(rows, 'twin\0local')).toBe(nul)
      expect(findIndexedProjectGroupDisplay(rows, 'absent')).toBeUndefined()
      expect(resolveIndexedProjectGroupOwner(rows, 'twin')).toEqual({ kind: 'ambiguous' })
      // Existing qualified namespace collision is unchanged; display has its own exact table.
      expect(resolveIndexedProjectGroupOwner(rows, 'twin', 'local')).toEqual({
        kind: 'resolved',
        owner: sameHost
      })
      expect(resolveIndexedProjectGroupOwner(rows, 'twin', 'runtime:server')).toEqual({
        kind: 'resolved',
        owner: remote
      })
      expect(reads).toBe(built)
      expect(findIndexedProjectGroupDisplay([remote, first], 'twin')).toBe(remote)
      expect(findIndexedProjectGroupDisplay([sameHost, remote], 'twin')?.name).toBe('')
      expect(resolveIndexedProjectGroupOwner([first, sameHost], 'twin')).toEqual({
        kind: 'resolved',
        owner: first
      })
      expect(resolveIndexedProjectGroupOwner([], 'missing')).toEqual({ kind: 'missing' })
    }
  )
})
