import { describe, expect, it } from 'vitest'
import {
  buildSmartWorkspaceSourceRows,
  getVisibleBranchResults,
  shouldHoldSourceResultsForQuery
} from '../../../../shared/new-workspace/smart-workspace-source-results'
import {
  isSmartWorkspaceLinearIssueIntentMatch,
  parseBoundedSmartWorkspaceLinearIssueInput,
  prioritizeSmartWorkspaceLinearIssueResults
} from '../../../../shared/new-workspace/smart-workspace-linear-intent'

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
