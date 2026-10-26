import { describe, expect, it } from 'vitest'

import {
  shouldHideTaskPageListChrome,
  type TaskPageListChromeVisibilityState
} from './task-page-list-chrome-visibility'

const baseState: TaskPageListChromeVisibilityState = {
  taskSource: 'github',
  hasGitHubDetail: false,
  hasGitLabDetail: false,
  hasJiraDetail: false,
  hasLinearIssueDetail: false,
  hasLinearProjectContext: false,
  hasLinearViewContext: false
}

describe('shouldHideTaskPageListChrome', () => {
  it('hides chrome for the active provider detail context', () => {
    expect(
      shouldHideTaskPageListChrome({
        ...baseState,
        taskSource: 'github',
        hasGitHubDetail: true
      })
    ).toBe(true)
    expect(
      shouldHideTaskPageListChrome({
        ...baseState,
        taskSource: 'gitlab',
        hasGitLabDetail: true
      })
    ).toBe(true)
    expect(
      shouldHideTaskPageListChrome({
        ...baseState,
        taskSource: 'jira',
        hasJiraDetail: true
      })
    ).toBe(true)
    expect(
      shouldHideTaskPageListChrome({
        ...baseState,
        taskSource: 'linear',
        hasLinearProjectContext: true
      })
    ).toBe(true)
  })

  it('keeps chrome visible when only another provider has stale detail state', () => {
    expect(
      shouldHideTaskPageListChrome({
        ...baseState,
        taskSource: 'github',
        hasJiraDetail: true,
        hasLinearProjectContext: true,
        hasLinearViewContext: true
      })
    ).toBe(false)
    expect(
      shouldHideTaskPageListChrome({
        ...baseState,
        taskSource: 'jira',
        hasGitHubDetail: true,
        hasGitLabDetail: true,
        hasLinearIssueDetail: true
      })
    ).toBe(false)
  })
})
