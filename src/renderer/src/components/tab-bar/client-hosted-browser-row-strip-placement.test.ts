import { describe, expect, it } from 'vitest'
import { resolveClientHostedBrowserRowStripGroupId } from './client-hosted-browser-row-strip-placement'

describe('resolveClientHostedBrowserRowStripGroupId', () => {
  // Why: picking the focused group instead would make a row hop strips as the user clicks around.
  it('keeps the same owner as focus moves', () => {
    const groups = [{ id: 'group-left' }, { id: 'group-right' }]

    expect(resolveClientHostedBrowserRowStripGroupId(groups)).toBe('group-left')
  })

  it('names no owner when the worktree has no groups', () => {
    expect(resolveClientHostedBrowserRowStripGroupId([])).toBeNull()
  })
})
