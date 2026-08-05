import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/types'
import { getLinearIssueBrowserUrl, getLinearPanelTarget } from './linear-panel-target'

function worktree(overrides: Partial<Worktree>): Worktree {
  return { ...(overrides as Worktree) }
}

describe('getLinearPanelTarget', () => {
  it('returns null when the worktree has no linked Linear issue', () => {
    expect(getLinearPanelTarget(null)).toBeNull()
    expect(getLinearPanelTarget(worktree({ linkedLinearIssue: null }))).toBeNull()
  })

  it('carries the recorded workspace id', () => {
    expect(
      getLinearPanelTarget(
        worktree({ linkedLinearIssue: 'ENG-123', linkedLinearIssueWorkspaceId: 'ws-1' })
      )
    ).toEqual({ identifier: 'ENG-123', workspaceId: 'ws-1', organizationUrlKey: null })
  })

  it('falls back to every workspace when the link predates multi-workspace support', () => {
    expect(getLinearPanelTarget(worktree({ linkedLinearIssue: 'ENG-9' }))?.workspaceId).toBe('all')
    expect(
      getLinearPanelTarget(
        worktree({ linkedLinearIssue: 'ENG-9', linkedLinearIssueWorkspaceId: '' })
      )?.workspaceId
    ).toBe('all')
  })
})

describe('getLinearIssueBrowserUrl', () => {
  const target = { identifier: 'ENG-123', workspaceId: 'ws-1', organizationUrlKey: 'acme' }

  it('prefers the url the fetched issue carries', () => {
    expect(getLinearIssueBrowserUrl(target, 'https://linear.app/acme/issue/ENG-123/title')).toBe(
      'https://linear.app/acme/issue/ENG-123/title'
    )
  })

  it('builds a url from the recorded org key before the issue hydrates', () => {
    expect(getLinearIssueBrowserUrl(target)).toBe('https://linear.app/acme/issue/ENG-123')
  })

  it('returns null when no org key was ever recorded', () => {
    expect(getLinearIssueBrowserUrl({ ...target, organizationUrlKey: null })).toBeNull()
  })
})
