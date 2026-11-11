import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('persists only recent marks and evicts the oldest timestamps over the cap', async () => {
  const now = 1800000000000
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const record = (viewedAt: number) => ({
    viewedAt,
    modifiedTime: null,
    contentSignature: '',
    entrySignature: ''
  })
  const stored = [
    ['expired', record(now - 91 * 24 * 60 * 60 * 1000)],
    ...Array.from({ length: 5000 }, (_, i) => [String(i), record(now - i)])
  ]
  const setItem = vi.fn()
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(stored), setItem })
  const { getReviewedDiffs, setDiffReviewed } = await import('./diff-reviewed-files')
  setDiffReviewed('new', record(now))
  const persisted = new Map(JSON.parse(setItem.mock.calls[0][1]))
  expect(persisted.size).toBe(5000)
  expect(persisted.has('expired')).toBe(false)
  expect(persisted.has('4999')).toBe(false)
  expect(getReviewedDiffs().has('new')).toBe(true)
})
