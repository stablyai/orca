import { describe, expect, it } from 'vitest'
import { getCardReviewList } from './worktree-card-attached-reviews'
import type { AttachedReview } from '../../../../shared/types'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'

const attached = (over: Partial<AttachedReview> = {}): AttachedReview => ({
  provider: 'github',
  number: 294,
  url: 'https://github.com/acme/app/pull/294',
  ...over
})

type PrDisplayMetadata = {
  provider: AttachedReview['provider']
  number: number
  title: string
  url?: string
  state?: WorktreeCardPrDisplay['state']
  status?: WorktreeCardPrDisplay['status']
}

const primary = (over: Partial<PrDisplayMetadata> = {}): WorktreeCardPrDisplay =>
  ({
    provider: 'github',
    number: 294,
    title: 'fix: something',
    url: 'https://github.com/acme/app/pull/294',
    ...over
  }) satisfies PrDisplayMetadata

describe('getCardReviewList', () => {
  it('lists the PRs the branch feeds without anything attached by hand', () => {
    // Why: this is the point of the whole feature. The branch's own lookup
    // already knows every PR it feeds, so nothing should have to be attached.
    const list = getCardReviewList(undefined, {
      ...primary({ number: 250 }),
      siblings: [
        {
          number: 251,
          url: 'https://github.com/acme/app/pull/251',
          baseRef: 'RELEASE/v1.14.0',
          state: 'open'
        },
        {
          number: 252,
          url: 'https://github.com/acme/app/pull/252',
          baseRef: 'stage',
          state: 'merged'
        }
      ]
    } as WorktreeCardPrDisplay)

    if (list.kind !== 'list') {
      throw new Error('expected a list')
    }
    expect(list.rows.map((row) => [row.number, row.state])).toEqual([
      [251, 'open'],
      [252, 'merged'],
      [250, undefined]
    ])
  })

  it('does not list a sibling twice when it was also attached by hand', () => {
    const list = getCardReviewList(
      [attached({ number: 251, url: 'https://github.com/acme/app/pull/251' })],
      {
        ...primary({ number: 250 }),
        siblings: [
          {
            number: 251,
            url: 'https://github.com/acme/app/pull/251',
            baseRef: 'stage',
            state: 'open'
          }
        ]
      } as WorktreeCardPrDisplay
    )

    if (list.kind !== 'list') {
      throw new Error('expected a list')
    }
    expect(list.rows.map((row) => row.number)).toEqual([251, 250])
  })

  it('keeps the detailed section when there is nothing but the auto-detected review', () => {
    expect(getCardReviewList(undefined, primary())).toEqual({ kind: 'single' })
    expect(getCardReviewList([], primary())).toEqual({ kind: 'single' })
    expect(getCardReviewList(null, null)).toEqual({ kind: 'single' })
  })

  it('keeps the detailed section when the only attached review is the detected one', () => {
    // Why: one review is one review however it got there, and the rich section
    // shows more than a list row can.
    expect(getCardReviewList([attached()], primary())).toEqual({ kind: 'single' })
  })

  it('switches to a uniform list once there are two', () => {
    const list = getCardReviewList(
      [
        attached({ baseRef: 'RELEASE/v1.14.0' }),
        attached({ number: 295, url: 'https://github.com/acme/app/pull/295', baseRef: 'stage' })
      ],
      primary()
    )

    expect(list.kind).toBe('list')
    if (list.kind !== 'list') {
      return
    }
    expect(list.rows.map((row) => [row.number, row.baseRef])).toEqual([
      [294, 'RELEASE/v1.14.0'],
      [295, 'stage']
    ])
  })

  it('carries state and checks onto the row Orca actually polled', () => {
    // Why: it is the only one with real check data; dropping it to make the
    // rows uniform would trade information for symmetry.
    const list = getCardReviewList(
      [
        attached({ baseRef: 'RELEASE/v1.14.0' }),
        attached({ number: 295, url: 'https://github.com/acme/app/pull/295', baseRef: 'stage' })
      ],
      primary({ state: 'open', status: 'success' })
    )

    if (list.kind !== 'list') {
      throw new Error('expected a list')
    }
    expect(list.rows[0]).toMatchObject({ number: 294, state: 'open', status: 'success' })
    expect(list.rows[1].state).toBeUndefined()
  })

  it('adds the auto-detected review when it was never attached', () => {
    const list = getCardReviewList(
      [attached({ number: 295, url: 'https://github.com/acme/app/pull/295', baseRef: 'stage' })],
      primary({ number: 300, url: 'https://github.com/acme/app/pull/300' })
    )

    if (list.kind !== 'list') {
      throw new Error('expected a list')
    }
    expect(list.rows.map((row) => row.number)).toEqual([295, 300])
  })

  it('does not list the same review twice when the urls differ cosmetically', () => {
    const list = getCardReviewList(
      [attached({ url: 'https://GitHub.com/acme/app/pull/294/' })],
      primary()
    )
    expect(list).toEqual({ kind: 'single' })
  })

  it('prefers the attached title, which is what the user recorded', () => {
    const list = getCardReviewList(
      [
        attached({ title: 'fix: something [v1.14.0]', baseRef: 'RELEASE/v1.14.0' }),
        attached({ number: 295, url: 'https://github.com/acme/app/pull/295', baseRef: 'stage' })
      ],
      primary({ title: 'fix: something' })
    )

    if (list.kind !== 'list') {
      throw new Error('expected a list')
    }
    expect(list.rows[0].title).toBe('fix: something [v1.14.0]')
  })

  it('skips an unsupported provider rather than rendering a row it cannot label', () => {
    const list = getCardReviewList(
      [
        attached({ baseRef: 'RELEASE/v1.14.0' }),
        attached({ number: 295, url: 'https://github.com/acme/app/pull/295', baseRef: 'stage' })
      ],
      {
        provider: 'unsupported',
        number: 9,
        url: 'https://example.com/pr/9'
      } as WorktreeCardPrDisplay
    )

    if (list.kind !== 'list') {
      throw new Error('expected a list')
    }
    expect(list.rows.map((row) => row.number)).toEqual([294, 295])
  })
})
