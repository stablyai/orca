import { describe, expect, it } from 'vitest'
import {
  buildSmartWorkspaceSourceRows,
  getBranchSearchRequest,
  getSmartWorkspaceEmptyHint
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

  it('describes empty Branch results after the empty-query search runs', () => {
    expect(getSmartWorkspaceEmptyHint('branches')).toBe('No matching branches.')
  })
})
