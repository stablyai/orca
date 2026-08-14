import { describe, expect, it } from 'vitest'
import {
  buildJiraIssueSearchJql,
  buildSmartWorkspaceSourceRows,
  getBranchSearchRequest,
  getSmartWorkspaceEmptyHint,
  getVisibleBranchResults,
  getVisibleHeldProviderResults,
  isBlockingJiraUrlIntent,
  shouldHoldSourceResultsForQuery
} from './smart-workspace-source-results'
import {
  getSmartWorkspaceLinearSearchQuery,
  isBlockingLinearUrlIntent,
  isSmartWorkspaceLinearIssueIntentMatch,
  parseBoundedSmartWorkspaceLinearIssueInput,
  parseBoundedSmartWorkspaceLinearIssueUrlIntent,
  prioritizeSmartWorkspaceLinearIssueResults
} from '../../../../shared/new-workspace/smart-workspace-linear-intent'
import {
  SMART_WORKSPACE_SOURCE_QUERY_MAX_BYTES,
  isSmartWorkspaceSourceQueryWithinLimit
} from '../../../../shared/new-workspace/smart-workspace-source-query'

describe('Branch source results', () => {
  it('requests empty-query branch results in Branch mode', () => {
    expect(
      getBranchSearchRequest({
        disabled: false,
        textOnly: false,
        mode: 'branches',
        selectedRepoId: 'repo-1',
        query: '',
        limit: 12
      })
    ).toEqual({ repoId: 'repo-1', query: '', limit: 12 })
  })

  it('does not request branch results when branches are disabled', () => {
    expect(
      getBranchSearchRequest({
        branchesEnabled: false,
        disabled: false,
        textOnly: false,
        mode: 'branches',
        selectedRepoId: 'repo-1',
        query: '',
        limit: 12
      })
    ).toBeNull()
    expect(
      getBranchSearchRequest({
        branchesEnabled: false,
        disabled: false,
        textOnly: false,
        mode: 'smart',
        selectedRepoId: 'repo-1',
        query: 'refund',
        limit: 12
      })
    ).toBeNull()
  })

  it('keeps Smart mode in its start-typing state for an empty query', () => {
    expect(
      getBranchSearchRequest({
        disabled: false,
        textOnly: false,
        mode: 'smart',
        selectedRepoId: 'repo-1',
        query: '',
        limit: 12
      })
    ).toBeNull()
  })

  it('rejects oversized pasted branch queries before provider search planning', () => {
    expect(
      getBranchSearchRequest({
        disabled: false,
        textOnly: false,
        mode: 'smart',
        selectedRepoId: 'repo-1',
        query: 'x'.repeat(4096),
        limit: 12
      })
    ).toBeNull()
  })

  it('rejects oversized whitespace before trimming branch queries', () => {
    expect(
      getBranchSearchRequest({
        disabled: false,
        textOnly: false,
        mode: 'branches',
        selectedRepoId: 'repo-1',
        query: ' '.repeat(SMART_WORKSPACE_SOURCE_QUERY_MAX_BYTES + 1),
        limit: 12
      })
    ).toBeNull()
  })

  it('hides stale branch rows when Smart mode input is cleared', () => {
    const rows = buildSmartWorkspaceSourceRows({
      mode: 'smart',
      value: '',
      branches: [{ refName: 'origin/old-result', localBranchName: 'old-result' }],
      githubItems: [],
      gitlabItems: [],
      linearIssues: [],
      gitlabAvailable: false,
      linearAvailable: false,
      resultLimit: 12
    })

    expect(rows).toEqual([])
  })

  it('hides branch results after the input is cleared while a prior query is still held', () => {
    expect(
      getVisibleBranchResults({
        mode: 'branches',
        value: '',
        selectedRepoId: 'repo-1',
        resultRepoId: 'repo-1',
        resultQuery: 'feature',
        branches: [{ refName: 'origin/feature', localBranchName: 'feature' }]
      })
    ).toEqual([])
  })

  it('keeps the last branch results while the user types ahead of the settled query', () => {
    expect(
      getVisibleBranchResults({
        mode: 'branches',
        value: 'featu',
        selectedRepoId: 'repo-1',
        resultRepoId: 'repo-1',
        resultQuery: 'feat',
        branches: [{ refName: 'origin/feature', localBranchName: 'feature' }]
      })
    ).toEqual([{ refName: 'origin/feature', localBranchName: 'feature' }])
  })

  it('keeps the last branch results while the user trims a prefix of the settled query', () => {
    expect(
      getVisibleBranchResults({
        mode: 'branches',
        value: 'fe',
        selectedRepoId: 'repo-1',
        resultRepoId: 'repo-1',
        resultQuery: 'feat',
        branches: [{ refName: 'origin/feature', localBranchName: 'feature' }]
      })
    ).toEqual([{ refName: 'origin/feature', localBranchName: 'feature' }])
  })

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
    // Why: prefix-only hold would keep "f" results under "fix-unrelated-payment-bug".
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

  it('keeps held branch results across case-only edits of a prefix query', () => {
    expect(
      getVisibleBranchResults({
        mode: 'branches',
        value: 'Feat',
        selectedRepoId: 'repo-1',
        resultRepoId: 'repo-1',
        resultQuery: 'feat',
        branches: [{ refName: 'origin/feature', localBranchName: 'feature' }]
      })
    ).toEqual([{ refName: 'origin/feature', localBranchName: 'feature' }])
  })

  it('hides held provider results immediately when the field is cleared ahead of debounce', () => {
    expect(
      getVisibleHeldProviderResults({
        items: [{ id: 'pr-1' }],
        value: '',
        debouncedQuery: 'fix'
      })
    ).toEqual([])
  })

  it('keeps held provider results while the user types ahead of debounce', () => {
    expect(
      getVisibleHeldProviderResults({
        items: [{ id: 'pr-1' }],
        value: 'fix',
        debouncedQuery: 'fi'
      })
    ).toEqual([{ id: 'pr-1' }])
  })

  it('shows provider results once the cleared field and debounce are both empty', () => {
    expect(
      getVisibleHeldProviderResults({
        items: [{ id: 'default-1' }],
        value: '',
        debouncedQuery: ''
      })
    ).toEqual([{ id: 'default-1' }])
  })

  it('uses stable cmdk values for typed-text actions', () => {
    expect(
      buildSmartWorkspaceSourceRows({
        mode: 'smart',
        value: 'refund-flow',
        branches: [],
        githubItems: [],
        gitlabItems: [],
        linearIssues: [],
        gitlabAvailable: false,
        linearAvailable: false,
        resultLimit: 12
      })[0]
    ).toMatchObject({ kind: 'use-name', value: 'use-name', name: 'refund-flow' })

    expect(
      buildSmartWorkspaceSourceRows({
        mode: 'branches',
        value: 'new-branch',
        branches: [],
        githubItems: [],
        gitlabItems: [],
        linearIssues: [],
        gitlabAvailable: false,
        linearAvailable: false,
        resultLimit: 12
      })[0]
    ).toMatchObject({ kind: 'create-branch', value: 'create-branch', name: 'new-branch' })
  })

  it('keeps matching empty-query branch results visible in Branch mode', () => {
    expect(
      getVisibleBranchResults({
        mode: 'branches',
        value: '',
        selectedRepoId: 'repo-1',
        resultRepoId: 'repo-1',
        resultQuery: '',
        branches: [{ refName: 'origin/main', localBranchName: 'main' }]
      })
    ).toEqual([{ refName: 'origin/main', localBranchName: 'main' }])
  })

  it('hides branch results for oversized pasted values before trimming', () => {
    expect(
      getVisibleBranchResults({
        mode: 'branches',
        value: ' '.repeat(SMART_WORKSPACE_SOURCE_QUERY_MAX_BYTES + 1),
        selectedRepoId: 'repo-1',
        resultRepoId: 'repo-1',
        resultQuery: '',
        branches: [{ refName: 'origin/main', localBranchName: 'main' }]
      })
    ).toEqual([])
  })

  it('keeps returned branch rows visible before the user types', () => {
    const rows = buildSmartWorkspaceSourceRows({
      mode: 'branches',
      value: '',
      branches: [
        { refName: 'main', localBranchName: 'main' },
        { refName: 'origin/feature/autofill', localBranchName: 'feature/autofill' }
      ],
      githubItems: [],
      gitlabItems: [],
      linearIssues: [],
      gitlabAvailable: false,
      linearAvailable: false,
      resultLimit: 12
    })

    expect(rows).toEqual([
      { kind: 'branch', value: 'branch-main', refName: 'main', localBranchName: 'main' },
      {
        kind: 'branch',
        value: 'branch-origin/feature/autofill',
        refName: 'origin/feature/autofill',
        localBranchName: 'feature/autofill'
      }
    ])
  })

  it('uses Linear rows from a paginated collection shape', () => {
    const rows = buildSmartWorkspaceSourceRows({
      mode: 'smart',
      value: '',
      branches: [],
      githubItems: [],
      gitlabItems: [],
      linearIssues: {
        items: [{ id: 'linear-1', identifier: 'ENG-1', title: 'Fix composer crash' } as never],
        hasMore: true
      },
      gitlabAvailable: false,
      linearAvailable: true,
      resultLimit: 12
    })

    expect(rows).toEqual([
      {
        kind: 'linear',
        value: 'linear-linear-1',
        issue: { id: 'linear-1', identifier: 'ENG-1', title: 'Fix composer crash' }
      }
    ])
  })

  it('keeps GitHub row values unique for the same item number across repos', () => {
    const rows = buildSmartWorkspaceSourceRows({
      mode: 'github',
      value: '',
      branches: [],
      githubItems: [
        { repoId: 'repo-a', type: 'issue', number: 123, title: 'Repo A issue' } as never,
        { repoId: 'repo-b', type: 'issue', number: 123, title: 'Repo B issue' } as never
      ],
      gitlabItems: [],
      linearIssues: [],
      gitlabAvailable: false,
      linearAvailable: false,
      resultLimit: 12
    })

    expect(rows.map((row) => row.value)).toEqual([
      'github-repo-a-issue-123',
      'github-repo-b-issue-123'
    ])
  })

  it('keeps GitLab row values unique for the same item number across repos', () => {
    const rows = buildSmartWorkspaceSourceRows({
      mode: 'gitlab',
      value: '',
      branches: [],
      githubItems: [],
      gitlabItems: [
        { repoId: 'repo-a', type: 'issue', number: 123, title: 'Repo A issue' } as never,
        { repoId: 'repo-b', type: 'issue', number: 123, title: 'Repo B issue' } as never
      ],
      linearIssues: [],
      gitlabAvailable: true,
      linearAvailable: false,
      resultLimit: 12
    })

    expect(rows.map((row) => row.value)).toEqual([
      'gitlab-repo-a-issue-123',
      'gitlab-repo-b-issue-123'
    ])
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

  it('suppresses typed and provider rows while unresolved Jira intent owns the query', () => {
    expect(
      buildSmartWorkspaceSourceRows({
        mode: 'smart',
        value: 'https://company.atlassian.net/browse/ORCA-123',
        branches: [{ refName: 'origin/main', localBranchName: 'main' }],
        githubItems: [{ repoId: 'repo-a', type: 'issue', number: 1, title: 'GitHub' } as never],
        gitlabItems: [],
        linearIssues: [],
        jiraIntent: true,
        jiraIssue: null,
        gitlabAvailable: false,
        linearAvailable: false,
        resultLimit: 12
      })
    ).toEqual([])
  })

  it('keeps a resolved Jira row when ignored URL data exceeds the generic search limit', () => {
    const jiraIssue = {
      key: 'ORCA-123',
      siteId: 'site-1'
    } as never
    expect(
      buildSmartWorkspaceSourceRows({
        mode: 'smart',
        value: `https://company.atlassian.net/browse/ORCA-123#${'x'.repeat(2100)}`,
        branches: [],
        githubItems: [],
        gitlabItems: [],
        linearIssues: [],
        jiraIntent: true,
        jiraIssue,
        gitlabAvailable: false,
        linearAvailable: false,
        resultLimit: 12
      })
    ).toEqual([{ kind: 'jira', value: 'jira-site-1-ORCA-123', issue: jiraIssue }])
  })

  it('ignores malformed Linear collection rows instead of throwing during render', () => {
    expect(() =>
      buildSmartWorkspaceSourceRows({
        mode: 'smart',
        value: '',
        branches: [],
        githubItems: [],
        gitlabItems: [],
        linearIssues: { items: { id: 'not-an-array' } } as never,
        gitlabAvailable: false,
        linearAvailable: true,
        resultLimit: 12
      })
    ).not.toThrow()
  })

  it('returns no rows for oversized pasted values before echoing or scanning results', () => {
    expect(
      buildSmartWorkspaceSourceRows({
        mode: 'smart',
        value: 'x'.repeat(SMART_WORKSPACE_SOURCE_QUERY_MAX_BYTES + 1),
        branches: [{ refName: 'origin/main', localBranchName: 'main' }],
        githubItems: [
          {
            get number(): number {
              throw new Error('oversized smart workspace rows must not scan GitHub results')
            }
          } as never
        ],
        gitlabItems: [],
        linearIssues: [],
        gitlabAvailable: false,
        linearAvailable: false,
        resultLimit: 12
      })
    ).toEqual([])
  })

  it('describes empty Branch results after the empty-query search runs', () => {
    expect(getSmartWorkspaceEmptyHint('branches')).toBe('No matching branches.')
  })

  it('describes Jira mode as searchable and supports pasted URLs', () => {
    expect(getSmartWorkspaceEmptyHint('jira')).toBe(
      'Start typing to search Jira issues, or paste an issue URL.'
    )
  })
})

describe('source query byte limits', () => {
  it('measures provider-search limits as UTF-8 bytes', () => {
    expect(isSmartWorkspaceSourceQueryWithinLimit('abc', 3)).toBe(true)
    expect(isSmartWorkspaceSourceQueryWithinLimit('😀', 3)).toBe(false)
    expect(
      isSmartWorkspaceSourceQueryWithinLimit(
        'é'.repeat(SMART_WORKSPACE_SOURCE_QUERY_MAX_BYTES / 2 + 1)
      )
    ).toBe(false)
  })
})

describe('Linear issue source input', () => {
  const issueUrl = 'https://linear.app/stably/issue/STA-4084/restore-osc-133-shell-integration'

  it('normalizes a Linear issue URL to its identifier for search', () => {
    expect(parseBoundedSmartWorkspaceLinearIssueInput(issueUrl)).toEqual({
      identifier: 'STA-4084',
      organizationUrlKey: 'stably'
    })
    expect(getSmartWorkspaceLinearSearchQuery(issueUrl)).toBe('STA-4084')
  })

  it('keeps arbitrary names as ordinary Linear search text', () => {
    expect(parseBoundedSmartWorkspaceLinearIssueInput('restore shell integration')).toBeNull()
    expect(getSmartWorkspaceLinearSearchQuery(' restore shell integration ')).toBe(
      'restore shell integration'
    )
  })

  it('only replaces the whole field for unmistakable Linear URL intent', () => {
    expect(isBlockingLinearUrlIntent('smart', issueUrl)).toBe(true)
    expect(isBlockingLinearUrlIntent('linear', issueUrl)).toBe(true)
    expect(isBlockingLinearUrlIntent('text', issueUrl)).toBe(false)
    expect(isBlockingLinearUrlIntent('github', issueUrl)).toBe(false)
    expect(isBlockingLinearUrlIntent('gitlab', issueUrl)).toBe(false)
    expect(isBlockingLinearUrlIntent('branches', issueUrl)).toBe(false)
    expect(isBlockingLinearUrlIntent('smart', 'STA-4084')).toBe(false)
    expect(isBlockingLinearUrlIntent('smart', 'restore-4084')).toBe(false)
    expect(
      isBlockingLinearUrlIntent('smart', 'https://linear.app.evil.test/stably/issue/STA-4084')
    ).toBe(false)
    expect(
      isBlockingLinearUrlIntent('smart', 'https://linear.app/stably/not-an-issue/issue/STA-4084')
    ).toBe(false)
    expect(
      isBlockingLinearUrlIntent('smart', 'https://linear.app/stably/issue/STA-4084/title/more')
    ).toBe(false)
    expect(
      isBlockingLinearUrlIntent(
        'smart',
        'https://linear.app/stably/issue/STA-4084%2Fnot-the-identifier'
      )
    ).toBe(false)
    expect(
      parseBoundedSmartWorkspaceLinearIssueUrlIntent(
        'https://linear.app/stably/issue/STA-4084/title'
      )
    ).toEqual({ identifier: 'STA-4084', organizationUrlKey: 'stably' })
  })

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

  it('keeps typed-text available while a Linear URL has not resolved yet', () => {
    expect(
      buildSmartWorkspaceSourceRows({
        mode: 'smart',
        value: issueUrl,
        branches: [],
        githubItems: [],
        gitlabItems: [],
        linearIssues: [],
        gitlabAvailable: false,
        linearAvailable: true,
        linearUrlIntentOwnsResults: true,
        resultLimit: 12
      })
    ).toEqual([{ kind: 'use-name', value: 'use-name', name: issueUrl }])
  })

  it('preserves arbitrary-name fallback for consumers without exact URL lookup', () => {
    const rows = buildSmartWorkspaceSourceRows({
      mode: 'smart',
      value: issueUrl,
      branches: [],
      githubItems: [],
      gitlabItems: [],
      linearIssues: [],
      gitlabAvailable: false,
      linearAvailable: true,
      resultLimit: 12
    })

    expect(rows).toEqual([{ kind: 'use-name', value: 'use-name', name: issueUrl }])
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

  it('matches bare Linear keys by identifier without changing provider order for names', () => {
    const issue = {
      id: 'stably-issue',
      identifier: 'STA-4084',
      url: issueUrl
    } as never
    const other = {
      id: 'other-issue',
      identifier: 'STA-9999',
      url: 'https://linear.app/stably/issue/STA-9999'
    } as never

    expect(
      isSmartWorkspaceLinearIssueIntentMatch(
        parseBoundedSmartWorkspaceLinearIssueInput('sta-4084')!,
        issue
      )
    ).toBe(true)
    expect(prioritizeSmartWorkspaceLinearIssueResults('restore shell', [other, issue])).toEqual([
      other,
      issue
    ])
  })

  it('rejects oversized Linear input before parsing it', () => {
    const oversized = `${issueUrl}#${'x'.repeat(SMART_WORKSPACE_SOURCE_QUERY_MAX_BYTES)}`

    expect(parseBoundedSmartWorkspaceLinearIssueInput(oversized)).toBeNull()
    expect(isBlockingLinearUrlIntent('smart', oversized)).toBe(false)
  })
})

describe('Jira issue search', () => {
  it('keeps valid Jira URL intent blocking in both Smart and Jira modes', () => {
    const firstUrl = 'https://company.atlassian.net/browse/ORCA-1'
    const secondUrl = 'https://company.atlassian.net/browse/ORCA-2'

    expect(isBlockingJiraUrlIntent('smart', firstUrl)).toBe(true)
    expect(isBlockingJiraUrlIntent('jira', firstUrl)).toBe(true)
    expect(isBlockingJiraUrlIntent('jira', secondUrl)).toBe(true)
    expect(isBlockingJiraUrlIntent('text', secondUrl)).toBe(false)
    expect(isBlockingJiraUrlIntent('jira', 'ordinary workspace name')).toBe(false)
  })

  it('builds text and exact-key JQL without accepting oversized input', () => {
    expect(buildJiraIssueSearchJql('test')).toBe('text ~ "test*"')
    expect(buildJiraIssueSearchJql('orca-123')).toBe('key = "ORCA-123"')
    expect(buildJiraIssueSearchJql('say "hello"')).toBe('text ~ "say \\"hello\\"*"')
    expect(
      buildJiraIssueSearchJql('x'.repeat(SMART_WORKSPACE_SOURCE_QUERY_MAX_BYTES + 1))
    ).toBeNull()
  })

  it('renders connected Jira search results in Jira mode', () => {
    const jiraIssue = {
      key: 'ORCA-123',
      siteId: 'site-1',
      title: 'Search Jira'
    } as never
    const rows = buildSmartWorkspaceSourceRows({
      mode: 'jira',
      value: 'search',
      branches: [],
      githubItems: [],
      gitlabItems: [],
      jiraIssues: [jiraIssue],
      linearIssues: [],
      gitlabAvailable: false,
      linearAvailable: false,
      resultLimit: 12
    })

    expect(rows).toEqual([{ kind: 'jira', value: 'jira-site-1-ORCA-123', issue: jiraIssue }])
  })
})
