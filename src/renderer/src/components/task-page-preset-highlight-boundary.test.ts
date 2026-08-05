import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseTaskQuery } from '../../../shared/task-query'
import { deriveGitHubTaskPreset, requiresGitHubViewerLogin } from './task-page-preset-highlight'

function derive(kind: 'prs' | 'issues', query: string, viewerLogin: string | null = null) {
  return deriveGitHubTaskPreset(kind, parseTaskQuery(query), viewerLogin)
}

describe('TaskPage preset tab highlighting boundary', () => {
  it('keeps the open presets active before viewer identity resolves', () => {
    expect(derive('prs', 'is:pr is:open')).toBe('prs')
    expect(derive('issues', 'is:issue is:open')).toBe('issues')
    expect(derive('prs', 'is:pr')).toBe('prs')
    expect(derive('issues', 'is:issue')).toBe('issues')
  })

  it('derives personal presets from @me', () => {
    expect(derive('prs', 'is:pr is:open author:@me')).toBe('my-prs')
    expect(derive('prs', 'is:pr is:open review-requested:@me')).toBe('review')
    expect(derive('issues', 'is:issue is:open assignee:@me')).toBe('my-issues')
  })

  it('matches the resolved viewer login case-insensitively', () => {
    expect(derive('prs', 'is:pr is:open author:OCTOCAT', 'octocat')).toBe('my-prs')
    expect(derive('prs', 'is:pr is:open review-requested:octocat', 'OctoCat')).toBe('review')
    expect(derive('issues', 'is:issue is:open assignee:octocat', 'OCTOCAT')).toBe('my-issues')
  })

  it('does not treat unresolved or other-user qualifiers as presets', () => {
    expect(derive('prs', 'is:pr is:open author:octocat')).toBeNull()
    expect(derive('prs', 'is:pr is:open author:hubot', 'octocat')).toBeNull()
    expect(derive('prs', 'is:pr is:open reviewed-by:octocat', 'octocat')).toBeNull()
    expect(derive('issues', 'is:issue is:open assignee:hubot', 'octocat')).toBeNull()
  })

  it('lets a matching personal qualifier win over a non-matching sibling qualifier', () => {
    expect(derive('prs', 'is:pr is:open author:hubot review-requested:octocat', 'octocat')).toBe(
      'review'
    )
  })

  it('guards closed and merged state before personal qualifiers', () => {
    expect(derive('prs', 'is:pr is:closed author:@me', 'octocat')).toBeNull()
    expect(derive('prs', 'is:pr is:merged review-requested:@me', 'octocat')).toBeNull()
    expect(derive('issues', 'is:issue is:closed assignee:@me', 'octocat')).toBeNull()
  })

  it('requests viewer identity only for an actual-login personal qualifier', () => {
    expect(requiresGitHubViewerLogin('prs', parseTaskQuery('is:pr is:open author:octocat'))).toBe(
      true
    )
    expect(
      requiresGitHubViewerLogin('prs', parseTaskQuery('is:pr is:open review-requested:@me'))
    ).toBe(false)
    expect(
      requiresGitHubViewerLogin('issues', parseTaskQuery('is:issue is:closed assignee:octocat'))
    ).toBe(false)
  })

  it('wires the pure derivation to preset button highlighting', () => {
    const source = readFileSync(join(__dirname, 'TaskPage.tsx'), 'utf8')
    expect(source).toContain(
      'deriveGitHubTaskPreset(activeGithubTaskKind, appliedTaskQuery, gitHubLogin)'
    )
    expect(source).toContain('requiresGitHubViewerLogin(activeGithubTaskKind, appliedTaskQuery)')
    expect(source).not.toContain('window.api.gh.viewer()')
    expect(source).toContain('const active = derivedTaskPreset === option.id')
  })
})
