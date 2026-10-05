import { describe, expect, it } from 'vitest'
import { IssuesList, WorkItemsList } from './rpc-contract/gitlab-params'

describe('GitLab task label RPC parameters', () => {
  it('accepts labels for issue listing', () => {
    expect(
      IssuesList.parse({ repo: 'id:repo-1', state: 'opened', labels: ['bug', 'needs review'] })
    ).toMatchObject({ labels: ['bug', 'needs review'] })
  })

  it('accepts labels for merge-request listing', () => {
    expect(
      WorkItemsList.parse({ repo: 'id:repo-1', state: 'opened', labels: ['bug'] })
    ).toMatchObject({ labels: ['bug'] })
  })
})
