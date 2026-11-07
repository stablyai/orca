import { describe, expect, it } from 'vitest'
import { getWorkspaceIntentName } from './workspace-name'

describe('getWorkspaceIntentName', () => {
  it('uses explicit user intent for linked issues without copying long titles', () => {
    expect(
      getWorkspaceIntentName({
        sourceText: 'https://github.com/mvanhorn/cli-printing-press/issues/2635 and fix it',
        workItem: {
          type: 'issue',
          number: 2635,
          title:
            "scorer/dogfood: live acceptance can't authenticate via the CLI's config/cookie credentials (scoped-home is env-only)"
        }
      })
    ).toEqual({
      displayName: 'Fix Issue 2635',
      seedName: 'fix-issue-2635'
    })
  })

  it('defaults PR and MR work to review-oriented identities', () => {
    expect(
      getWorkspaceIntentName({
        sourceText: 'https://github.com/acme/app/pull/1234 and check whether this is safe',
        workItem: {
          type: 'pr',
          number: 1234,
          title: 'Refactor account settings panel'
        }
      })
    ).toEqual({
      displayName: 'Review PR 1234',
      seedName: 'review-pr-1234'
    })
    expect(
      getWorkspaceIntentName({
        sourceText: 'fix https://gitlab.com/acme/app/-/merge_requests/77',
        workItem: {
          type: 'mr',
          provider: 'gitlab',
          number: 77,
          title: 'Resolve sync race'
        }
      })
    ).toEqual({
      displayName: 'Fix MR 77',
      seedName: 'fix-mr-77'
    })
  })

  it('does not treat an auto-generated slug as explicit user intent', () => {
    expect(
      getWorkspaceIntentName({
        sourceText: 'issue-123-fix-navbar',
        workItem: {
          type: 'issue',
          number: 456,
          title: 'Make importer handle archived rows'
        }
      })
    ).toEqual({
      displayName: 'Issue 456 Make Importer Handle',
      seedName: 'issue-456-make-importer-handle'
    })
  })
})
