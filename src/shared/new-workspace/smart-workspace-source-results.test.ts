import { describe, expect, it } from 'vitest'
import type { GitHubWorkItem } from '../github/work-items/work-item-types'
import {
  findSmartWorkspaceBranchIntentRef,
  resolveSmartWorkspaceCommandValue,
  type SmartWorkspaceCommandRow
} from './smart-workspace-command-value'
import {
  buildSmartWorkspaceSourceRows,
  getVisibleBranchResults,
  shouldHoldSourceResultsForQuery
} from './smart-workspace-source-results'
import {
  isSmartWorkspaceLinearIssueIntentMatch,
  parseBoundedSmartWorkspaceLinearIssueInput,
  prioritizeSmartWorkspaceLinearIssueResults
} from './smart-workspace-linear-intent'

describe('Branch source results', () => {
  it('hides held branch results when the live query diverges from the settled query', () => {
    expect(
      getVisibleBranchResults({
        mode: 'branches',
        value: 'bug',
        selectedRepoId: 'repo-1',
        resultRepoId: 'repo-1',
        resultQuery: 'feat',
        branches: [{ refName: 'origin/feature', localBranchName: 'feature' }]
      })
    ).toEqual([])
  })

  it('drops a short settled query once the live query grows far beyond a typing delta', () => {
    // Prefix-only retention would show f results under fix-unrelated-payment-bug.
    expect(
      getVisibleBranchResults({
        mode: 'branches',
        value: 'fix-unrelated-payment-bug',
        selectedRepoId: 'repo-1',
        resultRepoId: 'repo-1',
        resultQuery: 'f',
        branches: [{ refName: 'origin/foo', localBranchName: 'foo' }]
      })
    ).toEqual([])
    expect(
      shouldHoldSourceResultsForQuery({ resultQuery: 'f', value: 'fix-unrelated-payment-bug' })
    ).toBe(false)
    expect(shouldHoldSourceResultsForQuery({ resultQuery: 'feat', value: 'featu' })).toBe(true)
    expect(shouldHoldSourceResultsForQuery({ resultQuery: 'feat', value: 'feature/x' })).toBe(false)
  })

  it('gives Jira intent exclusive ownership of Smart results', () => {
    const jiraIssue = {
      id: 'jira-1',
      key: 'ORCA-123',
      siteId: 'site-1',
      title: 'Link Jira'
    } as never
    const rows = buildSmartWorkspaceSourceRows({
      mode: 'smart',
      value: 'https://company.atlassian.net/browse/ORCA-123',
      branches: [{ refName: 'origin/main', localBranchName: 'main' }],
      githubItems: [{ repoId: 'repo-a', type: 'issue', number: 1, title: 'GitHub' } as never],
      gitlabItems: [{ repoId: 'repo-a', type: 'issue', number: 2, title: 'GitLab' } as never],
      linearIssues: [{ id: 'linear-1', identifier: 'ENG-1', title: 'Linear' } as never],
      jiraIntent: true,
      jiraIssue,
      gitlabAvailable: true,
      linearAvailable: true,
      resultLimit: 12
    })

    expect(rows).toEqual([{ kind: 'jira', value: 'jira-site-1-ORCA-123', issue: jiraIssue }])
  })
})

describe('Linear issue source input', () => {
  const issueUrl = 'https://linear.app/stably/issue/STA-4084/restore-osc-133-shell-integration'

  it('keeps the exact Linear URL result ahead of provider result caps', () => {
    const exactIssue = {
      id: 'stably-issue',
      identifier: 'STA-4084',
      url: issueUrl
    } as never
    const rows = buildSmartWorkspaceSourceRows({
      mode: 'smart',
      value: issueUrl,
      branches: Array.from({ length: 12 }, (_, index) => ({
        refName: `origin/provider-result-${index}`,
        localBranchName: `provider-result-${index}`
      })),
      githubItems: Array.from({ length: 12 }, (_, index) => ({
        repoId: 'repo-1',
        type: 'issue',
        number: index + 1
      })) as never,
      gitlabItems: [],
      linearIssues: [exactIssue],
      gitlabAvailable: false,
      linearAvailable: true,
      linearUrlIntentOwnsResults: true,
      resultLimit: 12
    })

    expect(rows.map((row) => row.kind)).toEqual(['use-name', 'linear'])
    expect(rows[0]).toMatchObject({ kind: 'use-name', value: 'use-name', name: issueUrl })
    expect(rows[1]).toMatchObject({ value: 'linear-stably-issue', issue: exactIssue })
  })

  it('prioritizes only the issue from the URL organization', () => {
    const otherWorkspace = {
      id: 'other-issue',
      identifier: 'STA-4084',
      url: 'https://linear.app/other/issue/STA-4084'
    } as never
    const exactIssue = {
      id: 'stably-issue',
      identifier: 'STA-4084',
      url: issueUrl
    } as never
    const unrelatedIssue = {
      id: 'unrelated-issue',
      identifier: 'STA-9999',
      url: 'https://linear.app/stably/issue/STA-9999'
    } as never

    expect(
      prioritizeSmartWorkspaceLinearIssueResults(issueUrl, [
        otherWorkspace,
        unrelatedIssue,
        exactIssue
      ]).map((issue) => issue.id)
    ).toEqual(['stably-issue', 'other-issue', 'unrelated-issue'])
    expect(
      isSmartWorkspaceLinearIssueIntentMatch(
        parseBoundedSmartWorkspaceLinearIssueInput(issueUrl)!,
        otherWorkspace
      )
    ).toBe(false)
  })
})

describe('Branch intent resolution (#18701)', () => {
  const LIMIT = 12

  function branch(refName: string, localBranchName = refName) {
    return { refName, localBranchName }
  }

  function row(kind: SmartWorkspaceCommandRow['kind'], value: string): SmartWorkspaceCommandRow {
    return { kind, value }
  }

  it('picks exact matches or a unique prefix while treating local+remote aliases as one branch', () => {
    expect(
      findSmartWorkspaceBranchIntentRef('main', [branch('main-old'), branch('main')], LIMIT)
    ).toBe('main')
    expect(
      findSmartWorkspaceBranchIntentRef(
        'origin/main',
        [branch('refs/remotes/origin/main', 'main')],
        LIMIT
      )
    ).toBe('refs/remotes/origin/main')
    expect(
      findSmartWorkspaceBranchIntentRef(
        'origin/ma',
        [branch('refs/remotes/origin/main', 'main')],
        LIMIT
      )
    ).toBe('refs/remotes/origin/main')
    expect(findSmartWorkspaceBranchIntentRef('TV', [branch('TV-foo-bar')], LIMIT)).toBe(
      'TV-foo-bar'
    )
    expect(
      findSmartWorkspaceBranchIntentRef(
        'TV',
        [branch('TV-foo-bar'), branch('refs/remotes/origin/TV-foo-bar', 'TV-foo-bar')],
        LIMIT
      )
    ).toBe('TV-foo-bar')
  })

  it('keeps typed text when prefix is ambiguous, absent, case-mismatched, or from a full page', () => {
    expect(
      findSmartWorkspaceBranchIntentRef('TV', [branch('TV-foo-bar'), branch('TV-baz')], LIMIT)
    ).toBeNull()
    expect(
      findSmartWorkspaceBranchIntentRef(
        'feat',
        [
          branch('refs/remotes/origin/feature', 'feature'),
          branch('refs/remotes/upstream/feature', 'feature')
        ],
        LIMIT
      )
    ).toBeNull()
    expect(
      findSmartWorkspaceBranchIntentRef(
        'feat',
        [
          branch('refs/remotes/team/origin/feature', 'feature'),
          branch('refs/remotes/team/upstream/feature', 'feature')
        ],
        LIMIT
      )
    ).toBeNull()
    expect(
      findSmartWorkspaceBranchIntentRef(
        'feature',
        [
          branch('refs/remotes/origin/feature', 'feature'),
          branch('refs/remotes/upstream/feature', 'feature')
        ],
        LIMIT
      )
    ).toBeNull()
    expect(
      findSmartWorkspaceBranchIntentRef('TV', [branch('feature/TV-foo-bar')], LIMIT)
    ).toBeNull()
    expect(findSmartWorkspaceBranchIntentRef('  ', [branch('TV-foo-bar')], LIMIT)).toBeNull()
    expect(findSmartWorkspaceBranchIntentRef('tv', [branch('TV-foo-bar/tv')], LIMIT)).toBeNull()

    const fullPage = [
      branch('TV-foo-bar'),
      ...Array.from({ length: LIMIT - 1 }, (_, index) => branch(`x/TV-${index}`))
    ]
    expect(findSmartWorkspaceBranchIntentRef('TV', fullPage, LIMIT)).toBeNull()
    expect(findSmartWorkspaceBranchIntentRef('TV-foo-bar', fullPage, LIMIT)).toBe('TV-foo-bar')
  })

  it('arms branchIntentValue only when query is settled', () => {
    const rows = [row('use-name', 'use-name'), row('branch', 'branch-TV-foo-bar')]
    expect(
      resolveSmartWorkspaceCommandValue({
        currentValue: 'use-name',
        rows,
        isQueryStale: false,
        sourceIntent: null,
        branchIntentValue: 'branch-TV-foo-bar'
      })
    ).toBe('branch-TV-foo-bar')

    expect(
      resolveSmartWorkspaceCommandValue({
        currentValue: 'use-name',
        rows,
        isQueryStale: true,
        sourceIntent: null,
        branchIntentValue: 'branch-TV-foo-bar'
      })
    ).toBe('use-name')
  })

  it('reserves a row within the smart-mode cap for a unique branch intent', () => {
    const githubItems: GitHubWorkItem[] = Array.from({ length: LIMIT }, (_, index) => ({
      id: `gh-${index + 1}`,
      repoId: 'repo-1',
      type: 'issue',
      number: index + 1,
      title: `Issue ${index + 1}`,
      state: 'open',
      url: `https://github.com/stablyai/orca/issues/${index + 1}`,
      labels: [],
      updatedAt: '2026-11-18T00:00:00Z',
      author: null
    }))
    const rows = buildSmartWorkspaceSourceRows({
      mode: 'smart',
      value: 'origin/TV',
      branches: [{ refName: 'refs/remotes/origin/TV-foo-bar', localBranchName: 'TV-foo-bar' }],
      githubItems,
      gitlabItems: [],
      linearIssues: [],
      gitlabAvailable: false,
      linearAvailable: false,
      resultLimit: LIMIT
    })

    expect(rows).toHaveLength(LIMIT + 1)
    expect(rows[0]).toMatchObject({ kind: 'use-name', value: 'use-name' })
    expect(
      rows.some(
        (entry) => entry.kind === 'branch' && entry.refName === 'refs/remotes/origin/TV-foo-bar'
      )
    ).toBe(true)
  })
})
