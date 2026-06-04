import { describe, expect, it } from 'vitest'
import {
  buildSmartWorkspaceSourceRows,
  getBranchSearchRequest,
  getSmartWorkspaceEmptyHint,
  getVisibleBranchResults
} from './smart-workspace-source-results'

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

  it('hides branch results from a stale Branch-mode query', () => {
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

  it('describes empty Branch results after the empty-query search runs', () => {
    expect(getSmartWorkspaceEmptyHint('branches')).toBe('No matching branches.')
  })
})
