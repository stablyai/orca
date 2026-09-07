// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { isProjectGroupHeaderActionTarget } from './project-group-header-drag-contract'
import {
  isRepoHeaderActionTarget,
  REPO_HEADER_ACTION_SELECTOR
} from './project-header-drag-contract'

describe('project header action selectors', () => {
  it('includes the actions overlay for both repo and group helpers', () => {
    // Why: both helpers must share REPO_HEADER_ACTION_SELECTOR so overlay gaps
    // never arm drag/toggle on either header kind.
    expect(REPO_HEADER_ACTION_SELECTOR).toContain('[data-repo-header-actions]')

    const header = document.createElement('div')
    const actions = document.createElement('div')
    actions.setAttribute('data-repo-header-actions', '')
    header.append(actions)
    document.body.append(header)

    expect(isRepoHeaderActionTarget(actions, header)).toBe(true)
    expect(isProjectGroupHeaderActionTarget(actions, header)).toBe(true)
  })
})
