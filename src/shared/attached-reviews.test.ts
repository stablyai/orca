import { describe, expect, it } from 'vitest'
import { addAttachedReview, normalizeAttachedReviews } from './attached-reviews'
import type { AttachedReview } from './types'

const review = (over: Partial<AttachedReview> = {}): AttachedReview => ({
  provider: 'github',
  number: 68,
  url: 'https://github.com/acme/app/pull/68',
  ...over
})

describe('normalizeAttachedReviews', () => {
  it('returns an empty list for anything that is not an array', () => {
    for (const value of [undefined, null, 'nope', 42, {}]) {
      expect(normalizeAttachedReviews(value)).toEqual([])
    }
  })

  it('keeps well-formed entries, including the optional fields', () => {
    expect(
      normalizeAttachedReviews([review({ baseRef: 'stage', title: 'fix: something [stage]' })])
    ).toEqual([
      {
        provider: 'github',
        number: 68,
        url: 'https://github.com/acme/app/pull/68',
        baseRef: 'stage',
        title: 'fix: something [stage]'
      }
    ])
  })

  it('drops entries that could only render a dead row', () => {
    // Why: no usable URL means it cannot be opened, and no number means it
    // cannot be told apart from its siblings on the same branch.
    const broken = [
      review({ url: 'not-a-url' }),
      review({ url: 'ftp://github.com/acme/app/pull/68' }),
      { ...review(), number: 0 },
      { ...review(), number: 1.5 },
      { ...review(), provider: 'perforce' },
      null,
      'string',
      []
    ]
    expect(normalizeAttachedReviews(broken)).toEqual([])
  })

  it('collapses duplicates by URL so attaching twice is a no-op', () => {
    const list = normalizeAttachedReviews([
      review({ title: 'first' }),
      review({ title: 'second' }),
      review({ number: 69, url: 'https://github.com/acme/app/pull/69' })
    ])
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ number: 68, title: 'first' })
  })

  it('clamps an absurd payload so corrupted data cannot explode the panel', () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      review({ number: i + 1, url: `https://github.com/acme/app/pull/${i + 1}` })
    )
    expect(normalizeAttachedReviews(many).length).toBeLessThanOrEqual(50)
  })

  it('keeps a known state and drops one it does not recognize', () => {
    // Why: without state a merged review and an open one render identically,
    // which defeats the point of showing the whole trail of destinations.
    expect(normalizeAttachedReviews([review({ state: 'merged' })])[0]).toMatchObject({
      state: 'merged'
    })
    expect(normalizeAttachedReviews([{ ...review(), state: 'in-review' }])[0].state).toBeUndefined()
  })
})

describe('addAttachedReview', () => {
  it('appends to an empty or missing list', () => {
    expect(addAttachedReview(undefined, review())).toHaveLength(1)
    expect(addAttachedReview([], review())).toHaveLength(1)
  })

  it('refreshes an existing entry instead of duplicating it', () => {
    const first = addAttachedReview([], review({ title: 'old', baseRef: 'stage' }))
    const second = addAttachedReview(first, review({ title: 'new', baseRef: 'RELEASE/v1.14.0' }))

    expect(second).toHaveLength(1)
    expect(second[0]).toMatchObject({ title: 'new', baseRef: 'RELEASE/v1.14.0' })
  })

  it('keeps reviews that differ only in destination, which is the whole point', () => {
    // Why: the same head branch can ship to development, stage and a release
    // branch. Those are different PRs with different numbers and URLs.
    const list = [
      review({ number: 68, url: 'https://github.com/acme/app/pull/68', baseRef: 'development' }),
      review({ number: 69, url: 'https://github.com/acme/app/pull/69', baseRef: 'stage' })
    ].reduce<AttachedReview[]>((acc, item) => addAttachedReview(acc, item), [])

    expect(list.map((item) => item.baseRef)).toEqual(['development', 'stage'])
  })
})
