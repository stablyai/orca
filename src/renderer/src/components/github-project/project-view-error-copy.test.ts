import { describe, expect, it } from 'vitest'
import type { GitHubProjectViewError } from '../../../../shared/github/project-result-types'
import { projectViewErrorMessage } from './project-view-error-copy'

describe('projectViewErrorMessage', () => {
  it("keeps the host's message when this build cannot name the sentence", () => {
    // Wire data from a newer host can carry a reason this build does not know.
    const newerHostError: GitHubProjectViewError = JSON.parse(
      '{"type":"network_error","reason":"proxy_rejected","message":"The proxy rejected the request."}'
    )
    const olderHostErrors: GitHubProjectViewError[] = [
      { type: 'not_found', message: 'Owner not found.' },
      {
        type: 'auth_required',
        message:
          'GitHub CLI is not authenticated to ghe.example.com. Run gh auth login --hostname ghe.example.com.'
      },
      { type: 'schema_drift', message: 'Could not read this project view: response missing data.' }
    ]
    for (const error of [newerHostError, ...olderHostErrors]) {
      expect(projectViewErrorMessage(error)).toBe(error.message)
    }
  })
})
