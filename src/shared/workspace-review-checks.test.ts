import { describe, expect, it } from 'vitest'
import type { WorkspaceAttachment } from './worktree/types'
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
  it('gives pending checks precedence over unknown data and passing over neutral', () => {
    const first = attachment(1)
    const second = attachment(2)
    expect(
      summarizeWorkspaceReviewChecks([first, second], map([[first, details(first, 'pending')]]))
    ).toMatchObject({ state: 'pending' })
    expect(
      summarizeWorkspaceReviewChecks(
        [first, second],
        map([
          [first, details(first, 'neutral')],
          [second, details(second, 'success')]
        ])
      )
    ).toMatchObject({ state: 'success' })
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
