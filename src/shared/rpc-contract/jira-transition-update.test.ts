import { describe, expect, it } from 'vitest'
import { IssueUpdate } from './jira-params'

describe('transition update wire contract', () => {
  it('preserves required fields and a comment on paired hosts', () => {
    const input = {
      key: 'APP-1',
      updates: {
        transitionId: '31',
        transitionFields: { resolution: { id: '1' } },
        transitionComment: 'Verified fix'
      }
    }
    expect(IssueUpdate.parse(input)).toEqual(input)
  })

  it('accepts old-client bare transitions', () => {
    const input = { key: 'APP-1', updates: { transitionId: '31' } }
    expect(IssueUpdate.parse(input)).toEqual(input)
  })

  it('rejects malformed fields and comment values before invoking Jira', () => {
    expect(
      IssueUpdate.safeParse({ key: 'APP-1', updates: { transitionId: '31', transitionFields: [] } })
        .success
    ).toBe(false)
    expect(
      IssueUpdate.safeParse({ key: 'APP-1', updates: { transitionId: '31', transitionComment: 1 } })
        .success
    ).toBe(false)
  })
})
