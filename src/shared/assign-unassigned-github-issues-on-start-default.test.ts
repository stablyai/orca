import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'

describe('assign unassigned GitHub issues on start default', () => {
  it('does not assign unassigned GitHub issues on Start until the user opts in', () => {
    expect(getDefaultSettings('/tmp').assignUnassignedGitHubIssuesOnStart).toBe(false)
  })
})
