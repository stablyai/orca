import { getProviderChecksOutcome, summarizeProviderChecks } from './provider-check-summary'
import { describe, expect, it } from 'vitest'
import type { WorkspaceAttachment } from './worktree/types'
import type { HostedReviewState } from './hosted-review'
import { getWorkspaceAttachmentKey } from './workspace-attachment-normalization'
import {
  summarizeWorkspaceReviewChecks,
  type WorkspaceReviewCheckDetails
} from './workspace-review-checks'

function attachment(number: number, provider: 'github' | 'gitlab' = 'github'): WorkspaceAttachment {
  return {
    provider,
    type: provider === 'gitlab' ? 'mr' : 'pr',
    number,
    url:
      provider === 'github'
        ? `https://github.com/acme/orca/pull/${number}`
        : `https://gitlab.com/acme/orca/-/merge_requests/${number}`
  }
}
function details(
  item: WorkspaceAttachment,
  status: 'success' | 'failure' | 'pending' | 'neutral',
  stale = false
): WorkspaceReviewCheckDetails {
  return { stale, review: { provider: item.provider, number: item.number, url: item.url, status } }
}
function map(
  entries: [WorkspaceAttachment, WorkspaceReviewCheckDetails][]
): Record<string, WorkspaceReviewCheckDetails> {
  return Object.fromEntries(
    entries.map(([item, detail]) => [getWorkspaceAttachmentKey(item), detail])
  )
}

describe('all workspace review checks', () => {
  it.each<{ states: (HostedReviewState | undefined)[]; expected: HostedReviewState | undefined }>([
    { states: ['merged', 'merged'], expected: 'merged' },
    { states: ['draft', 'draft'], expected: 'draft' },
    { states: ['closed', 'closed'], expected: 'closed' },
    { states: ['merged', 'open'], expected: 'open' },
    { states: ['merged', 'draft'], expected: 'open' },
    { states: ['merged', 'closed'], expected: 'closed' },
    { states: ['merged', undefined], expected: undefined },
    { states: ['draft', undefined], expected: 'open' },
    { states: [undefined, undefined], expected: undefined }
  ])(
    'derives collection lifecycle $states independently of passing checks',
    ({ states, expected }) => {
      const items = states.map((_, index) =>
        attachment(index + 1, index === 0 ? 'github' : 'gitlab')
      )
      const entries: [WorkspaceAttachment, WorkspaceReviewCheckDetails][] = items.map(
        (item, index) => [
          item,
          {
            review: {
              provider: item.provider,
              number: item.number,
              url: item.url,
              state: states[index],
              status: 'success'
            }
          }
        ]
      )
      const summary = summarizeWorkspaceReviewChecks(items, map(entries))
      expect(summary.reviewState).toBe(expected)
      expect(summary).toMatchObject({
        state: 'success',
        passed: items.length
      })
    }
  )

  it('retains matched lifecycle and staleness without check results and rejects foreign details', () => {
    const item = attachment(1)
    const retained = {
      stale: true,
      review: { provider: 'github', number: 1, url: item.url, state: 'merged' }
    } as const
    expect(summarizeWorkspaceReviewChecks([item], map([[item, retained]]))).toMatchObject({
      reviewState: 'merged',
      stale: 1,
      state: 'unknown',
      unknown: 1
    })
    const foreign = {
      ...retained,
      review: { ...retained.review, url: 'https://github.com/other/project/pull/1' }
    }
    expect(summarizeWorkspaceReviewChecks([item], map([[item, foreign]]))).toMatchObject({
      reviewState: undefined,
      stale: 0,
      state: 'unknown'
    })
  })

  it('aggregates every review rather than a selected compatibility slot', () => {
    const first = attachment(1)
    const second = attachment(2)
    expect(
      summarizeWorkspaceReviewChecks(
        [first, second],
        map([
          [first, details(first, 'success')],
          [second, details(second, 'failure')]
        ])
      )
    ).toMatchObject({ state: 'failure', total: 2, known: 2, passed: 1, failed: 1 })
  })
  it('keeps all unknown or partially known collections from looking green', () => {
    const first = attachment(1)
    const second = attachment(2)
    expect(summarizeWorkspaceReviewChecks([first, second], {})).toMatchObject({
      state: 'unknown',
      unknown: 2
    })
    expect(
      summarizeWorkspaceReviewChecks([first, second], map([[first, details(first, 'success')]]))
    ).toMatchObject({ state: 'unknown', known: 1, unknown: 1 })
  })
  it('never certifies stale success and conservatively retains stale failure', () => {
    const item = attachment(1)
    expect(
      summarizeWorkspaceReviewChecks([item], map([[item, details(item, 'success', true)]]))
    ).toMatchObject({ state: 'unknown', stale: 1 })
    expect(
      summarizeWorkspaceReviewChecks([item], map([[item, details(item, 'failure', true)]]))
    ).toMatchObject({ state: 'failure', stale: 1 })
  })
  it('isolates equal numbers by provider and repository scope', () => {
    const github = attachment(1)
    const gitlab = attachment(1, 'gitlab')
    const foreign = { ...github, url: 'https://github.com/other/project/pull/1' }
    expect(
      summarizeWorkspaceReviewChecks(
        [github, gitlab],
        map([
          [github, details(gitlab, 'success')],
          [gitlab, details(github, 'failure')]
        ])
      )
    ).toMatchObject({ state: 'unknown', unknown: 2, failed: 0 })
    expect(
      summarizeWorkspaceReviewChecks([github], map([[github, details(foreign, 'success')]]))
    ).toMatchObject({ state: 'unknown', unknown: 1 })
  })
  it('ignores tasks and deduplicates review metadata without filtering lifecycle states', () => {
    const first = attachment(1)
    const second = attachment(2)
    const task: WorkspaceAttachment = { provider: 'github', type: 'issue', number: 3 }
    expect(
      summarizeWorkspaceReviewChecks(
        [first, first, second, task],
        map([
          [first, details(first, 'failure')],
          [second, details(second, 'success')]
        ])
      )
    ).toMatchObject({ total: 2, failed: 1, state: 'failure' })
    expect(summarizeWorkspaceReviewChecks([task], {})).toMatchObject({ state: 'none', total: 0 })
  })
})

it('counts nested cancelled and pending review outcomes once per review', () => {
  const first = attachment(1)
  const second = attachment(2)
  const summaryFor = (...conclusions: string[]) =>
    summarizeProviderChecks(conclusions.map((conclusion) => ({ status: 'completed', conclusion })))
  const mixed = {
    ...details(first, 'failure'),
    review: {
      ...details(first, 'failure').review!,
      checksSummary: summaryFor('cancelled', 'pending')
    }
  }
  const cancelled = {
    ...details(second, 'failure'),
    review: {
      ...details(second, 'failure').review!,
      checksSummary: summaryFor('cancelled', 'cancelled')
    }
  }
  const alone = summarizeWorkspaceReviewChecks([first], map([[first, mixed]]))
  expect(alone).toMatchObject({ total: 1, pending: 1, failed: 0, cancelled: 0 })
  expect(getProviderChecksOutcome(alone)).toBe('pending')
  const combined = summarizeWorkspaceReviewChecks(
    [first, second],
    map([
      [first, mixed],
      [second, cancelled]
    ])
  )
  expect(combined).toMatchObject({ total: 2, failed: 1, cancelled: 1, pending: 1 })
  expect(getProviderChecksOutcome(combined)).toBe('pending')
  expect(
    getProviderChecksOutcome(summarizeWorkspaceReviewChecks([second], map([[second, cancelled]])))
  ).toBe('cancelled')
  expect(
    getProviderChecksOutcome(
      summarizeWorkspaceReviewChecks([first, second], map([[second, cancelled]]))
    )
  ).not.toBe('success')
})
