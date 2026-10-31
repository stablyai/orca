import { afterEach, describe, expect, it } from 'vitest'
import { createTestStore } from '@/store/slices/store-test-helpers'
import {
  _resetContentRekeysForTests,
  contentRekeyOutcome,
  expectContentRekey,
  shownContentRekeyPatch
} from './layout-owner-content-rekeys'

function rekeyOf(fileId: string): void {
  expectContentRekey({ shows: () => true, patch: () => ({}) }, [fileId])
}

afterEach(() => _resetContentRekeysForTests())

describe('pending content rekeys past the cap', () => {
  it('settle the oldest as dropped and keep the newest 64 for their frame', async () => {
    rekeyOf('file-0')
    const oldest = contentRekeyOutcome(['file-0'])
    for (let index = 1; index <= 64; index += 1) {
      rekeyOf(`file-${index}`)
    }
    const newest = contentRekeyOutcome(['file-64'])

    await expect(oldest).resolves.toBe(false)
    shownContentRekeyPatch(createTestStore().getState(), {})
    await expect(newest).resolves.toBe(true)
  })
})
