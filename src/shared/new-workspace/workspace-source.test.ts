import { describe, expect, it } from 'vitest'
import { resolveComposerBranchSelection } from '../composer-branch-selection'
import {
  buildLinearWorkspaceSource,
  buildWorkspaceSourceSelection,
  getWorkspaceSourceProvider,
  shouldApplyWorkspaceSourceAutoName,
  shouldPreserveWorkspaceSourceOnRepoChange
} from './workspace-source'

describe('workspace source policy', () => {
  it.each([
    ['refs/remotes/origin/topic', 'origin/topic'],
    ['refs/heads/topic', 'topic'],
    ['origin/topic', 'origin/topic']
  ])('shows selected branch %s without rewriting its action', (refName, label) => {
    const selection = resolveComposerBranchSelection({
      refName,
      localBranchName: 'topic',
      currentName: '',
      lastAutoName: ''
    })
    expect(
      buildWorkspaceSourceSelection({ linkedWorkItem: null, baseBranch: selection.baseBranch })
    ).toEqual({ kind: 'branch', label })
    expect(selection.baseBranch).toBe(refName)
  })

  it.each(['347', '002', '#347', 'https://github.com/fixture/repo/issues/347'])(
    'keeps manual name %s after the query field becomes a selected source',
    (currentName) => {
      expect(
        shouldApplyWorkspaceSourceAutoName({
          currentName,
          lastAutoName: 'fix-export',
          lookupTextIsQuery: false
        })
      ).toBe(false)
      expect(
        shouldApplyWorkspaceSourceAutoName({
          currentName,
          lastAutoName: 'fix-export'
        })
      ).toBe(true)
    }
  )
  const linear = buildLinearWorkspaceSource({
    identifier: 'ENG-42',
    title: 'Ship mobile parity',
    url: 'https://linear.app/acme/issue/ENG-42/ship-mobile-parity',
    workspaceId: 'workspace-1',
    branchName: '  team/eng-42-ship-mobile-parity  '
  })

  it('preserves global work-item sources across repo changes', () => {
    expect(shouldPreserveWorkspaceSourceOnRepoChange(linear)).toBe(true)
    expect(
      shouldPreserveWorkspaceSourceOnRepoChange({
        provider: 'jira',
        type: 'issue',
        number: 0,
        title: 'Workspace scoped',
        url: 'https://acme.atlassian.net/browse/FUS-1'
      })
    ).toBe(true)
    // Jira smart results may omit provider; preserve via URL/identifier inference too.
    expect(
      shouldPreserveWorkspaceSourceOnRepoChange({
        type: 'issue',
        number: 0,
        title: 'Inferred Jira',
        url: 'https://acme.atlassian.net/browse/FUS-1',
        jiraIdentifier: 'FUS-1'
      })
    ).toBe(true)
    expect(
      shouldPreserveWorkspaceSourceOnRepoChange({
        provider: 'github',
        type: 'issue',
        number: 1,
        title: 'Repo scoped',
        url: 'https://github.com/o/r/issues/1'
      })
    ).toBe(false)
    // GitLab is repo-scoped; clear explicit and URL-inferred sources through folder/project-group delegates too.
    expect(
      shouldPreserveWorkspaceSourceOnRepoChange({
        provider: 'gitlab',
        type: 'mr',
        number: 2,
        title: 'Repo scoped MR',
        url: 'https://gitlab.com/o/r/-/merge_requests/2'
      })
    ).toBe(false)
    expect(
      shouldPreserveWorkspaceSourceOnRepoChange({
        type: 'issue',
        number: 3,
        title: 'Inferred GitLab',
        url: 'https://gitlab.example.com/g/p/-/work_items/3'
      })
    ).toBe(false)
    expect(shouldPreserveWorkspaceSourceOnRepoChange(null)).toBe(false)
  })

  it('shares provider inference, selection labels, and auto-name gates', () => {
    const legacyGitLab = {
      type: 'issue' as const,
      number: 7,
      title: 'Self hosted',
      url: 'https://gitlab.example.com/g/p/-/work_items/7'
    }
    expect(getWorkspaceSourceProvider(legacyGitLab)).toBe('gitlab')
    expect(buildWorkspaceSourceSelection({ linkedWorkItem: legacyGitLab })).toMatchObject({
      kind: 'gitlab-issue',
      label: '#7 Self hosted'
    })
    expect(shouldApplyWorkspaceSourceAutoName({ currentName: '#42', lastAutoName: 'old' })).toBe(
      true
    )
    expect(
      shouldApplyWorkspaceSourceAutoName({ currentName: 'my workspace', lastAutoName: 'old' })
    ).toBe(false)
  })
})
