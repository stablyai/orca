import { describe, expect, it } from 'vitest'
import {
  clearGitHubLinkCopied,
  markGitHubLinkCopied,
  resolveGitHubLinkCopyState
} from './github-link-copy-state'

describe('GitHub link copy state', () => {
  it('resets copied state when the rendered work item changes', () => {
    const state = markGitHubLinkCopied('item-1')

    expect(resolveGitHubLinkCopyState(state, 'item-2')).toEqual({
      workItemId: 'item-2',
      copied: false
    })
  })

  it('ignores stale timer clears from a previous work item', () => {
    const state = markGitHubLinkCopied('item-2')

    expect(clearGitHubLinkCopied(state, 'item-1')).toBe(state)
  })
})
