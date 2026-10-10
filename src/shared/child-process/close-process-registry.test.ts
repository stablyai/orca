import { describe, expect, it, vi } from 'vitest'
import { closeProcessRegistry } from './close-process-registry'

describe('closeProcessRegistry', () => {
  it('continues closing sibling processes when one close rejects', async () => {
    const entries = new Set(['first', 'second'])
    const closeEntry = vi.fn(async (id: string) => {
      if (id === 'first' && closeEntry.mock.calls.filter(([entry]) => entry === id).length === 1) {
        throw new Error('transient close failure')
      }
      entries.delete(id)
      return true
    })

    await expect(
      closeProcessRegistry({
        attempts: 3,
        hasEntries: () => entries.size > 0,
        entryIds: () => entries,
        closeEntry,
        failureMessage: 'processes remain live'
      })
    ).resolves.toBeUndefined()

    expect(closeEntry.mock.calls.map(([id]) => id)).toEqual(['first', 'second', 'first'])
  })

  it('reports every rejected proof after the bounded retries', async () => {
    const failure = new Error('close failed')

    await expect(
      closeProcessRegistry({
        attempts: 3,
        hasEntries: () => true,
        entryIds: () => ['session-1'],
        closeEntry: async () => {
          throw failure
        },
        failureMessage: 'processes remain live'
      })
    ).rejects.toMatchObject({
      message: 'processes remain live',
      errors: [failure, failure, failure]
    })
  })
})
