import { createElement } from 'react'
import type { Repo } from '../../../../../shared/repo-types'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type {
  GitHubWorkItem,
  GitHubWorkItemDetails
} from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import { useGitHubWorkItemDetails } from './use-github-work-item-details'
import { useRepoLabels } from '@/hooks/useGitHubRepoMetadata'
import { GitHubWorkItemTargetContext } from './github-work-item-target-context'

export function workItemDetailsProvider(
  io: {
    host: string
    upstreamIsIssue: boolean
    unexpected: string[]
  },
  item: (owner: string) => { url: string }
) {
  const response = (value: unknown) => ({ stdout: JSON.stringify(value) })
  return async (args: string[]) => {
    const owner =
      args.includes('fork/widgets') ||
      args.includes('owner=fork') ||
      args.some((a) => a.startsWith('repos/fork/'))
        ? 'fork'
        : 'upstream'
    const query = args.find((a) => a.startsWith('query=')) ?? ''
    if (args.some((a) => a.endsWith('/labels'))) {
      return { stdout: `${owner}-label` }
    }
    const issueReply = {
      number: 93,
      title: `${owner} issue`,
      state: 'open',
      html_url: `https://${io.host}/${owner}/widgets/issues/93`,
      updated_at: '2026-10-28T00:00:00Z',
      user: null,
      labels: [],
      assignees: [],
      body: `${owner} issue body`
    }
    if (args[0] === 'issue' && args[1] === 'view') {
      return response({
        number: 93,
        title: issueReply.title,
        state: 'OPEN',
        url: issueReply.html_url,
        updatedAt: issueReply.updated_at,
        author: null,
        labels: []
      })
    }
    if (args[0] === 'issue' && ['close', 'reopen', 'edit'].includes(args[1])) {
      return { stdout: '' }
    }
    if (args[0] === 'api' && args.includes('PATCH')) {
      if (args.some((arg) => /^repos\/(fork|upstream)\/widgets\/(issues|pulls)\/93$/.test(arg))) {
        return response({ number: 93 })
      }
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      if (io.upstreamIsIssue && owner === 'upstream') {
        throw new Error('HTTP 404: Not Found')
      }
      return response({
        number: 93,
        title: owner,
        state: 'OPEN',
        url: item(owner).url,
        labels: [],
        updatedAt: '2026-10-28T00:00:00Z',
        author: null,
        isDraft: false,
        headRefName: 'feature',
        baseRefName: 'main',
        headRefOid: `${owner}-head`,
        reviewRequests: [],
        latestReviews: []
      })
    }
    if (args.some((arg) => /^repos\/(fork|upstream)\/widgets\/issues\/93$/.test(arg))) {
      return response(issueReply)
    }
    if (query.includes('viewerViewedState')) {
      return response({
        data: {
          repository: {
            pullRequest: { participants: { nodes: [] } },
            viewedPullRequest: {
              id: `PR_${owner}`,
              files: {
                nodes: [{ path: `${owner}.ts`, viewerViewedState: 'UNVIEWED' }],
                pageInfo: { hasNextPage: false }
              }
            }
          }
        }
      })
    }
    if (query.includes('reviewThreads')) {
      return response({
        data: {
          repository: {
            pullRequest: {
              comments: {
                nodes: [
                  {
                    id: `COMMENT_${owner}`,
                    databaseId: 1,
                    author: null,
                    body: `${owner} conversation`,
                    createdAt: '2026-10-28',
                    url: item(owner).url
                  }
                ]
              },
              reviews: { nodes: [] },
              reviewThreads: { nodes: [] }
            }
          }
        }
      })
    }
    if (query.includes('statusCheckRollup')) {
      return response({
        data: {
          repository: {
            pullRequest: {
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        contexts: {
                          nodes: [
                            {
                              __typename: 'CheckRun',
                              name: `${owner} check`,
                              status: 'COMPLETED',
                              conclusion: 'SUCCESS'
                            }
                          ]
                        }
                      }
                    }
                  }
                ]
              }
            }
          }
        }
      })
    }
    if (args.some((a) => a.includes('/files?'))) {
      return response([
        {
          filename: `${owner}.ts`,
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: '@@ -1 +1 @@\n-a\n+b'
        }
      ])
    }
    if (args.some((a) => a.endsWith('/pulls/93'))) {
      if (io.upstreamIsIssue && owner === 'upstream') {
        throw new Error('HTTP 404: Not Found')
      }
      return response({
        number: 93,
        title: owner,
        state: 'open',
        html_url: item(owner).url,
        updated_at: '2026-10-28T00:00:00Z',
        user: null,
        labels: [],
        assignees: [],
        draft: false,
        body: `${owner} body`,
        head: { sha: `${owner}-head`, ref: 'feature', repo: { owner: { login: owner } } },
        base: { sha: `${owner}-base`, ref: 'main', repo: { owner: { login: owner } } }
      })
    }
    if (query.includes('viewerDefaultMergeMethod')) {
      return response({
        data: {
          repository: {
            viewerDefaultMergeMethod: 'SQUASH',
            mergeCommitAllowed: true,
            rebaseMergeAllowed: true,
            squashMergeAllowed: true,
            autoMergeAllowed: false,
            mergeQueue: null,
            ref: { rules: { nodes: [] } }
          }
        }
      })
    }
    if (query.includes('participants(first: 100)')) {
      return response({
        data: {
          repository: {
            pullRequest: { participants: { nodes: [] } },
            issue: { participants: { nodes: [] } }
          }
        }
      })
    }
    io.unexpected.push(JSON.stringify(args))
    throw new Error(`Unexpected gh command: ${JSON.stringify(args)}`)
  }
}

export const response = (value: unknown) => ({ stdout: JSON.stringify(value) })

export function workItemDetailsItem(owner: string, host: string): GitHubWorkItem {
  return {
    id: 'pr:93',
    repoId: 'clone',
    type: 'pr',
    number: 93,
    title: owner,
    url: `https://${host}/${owner}/widgets/pull/93`,
    prRepo: { owner, repo: 'widgets', host },
    state: 'open',
    labels: [],
    author: null,
    updatedAt: ''
  }
}

function Metadata({ enabled }: { enabled: boolean }) {
  useRepoLabels(enabled ? '/clone' : null, enabled ? 'clone' : null)
  return null
}

export function useWorkItemDetailsProbe({
  opened,
  sourceContext,
  metadataEnabled = true,
  publish
}: {
  opened: GitHubWorkItem
  sourceContext?: TaskSourceContext
  metadataEnabled?: boolean
  publish: (value: ReturnType<typeof useGitHubWorkItemDetails>) => void
}) {
  const view = useGitHubWorkItemDetails({
    workItem: opened,
    repoPath: '/clone',
    effectiveRepoId: 'clone',
    sourceContext
  })
  publish(view)
  return createElement(
    GitHubWorkItemTargetContext.Provider,
    { value: view.targetContext },
    createElement(Metadata, { enabled: metadataEnabled })
  )
}

export type WorkItemDetailsPublished = {
  onCommentAdded: (comment: PRComment) => void
  body: string
  details: GitHubWorkItemDetails | null
  detailsCacheKey: string | null
  appendOptimisticComment: (comment: PRComment) => void
}

export function accountCaptureProvider(terminal: (args: string[], options: unknown) => unknown) {
  return async (args: string[], options: unknown) => {
    if (args.some((arg) => arg.includes('markFileAsViewed(input:'))) {
      return response({ data: { markFileAsViewed: { pullRequest: { id: 'PR_fork' } } } })
    }
    if (args.some((arg) => arg.includes('/assignees?'))) {
      return response({ login: 'assignee', avatar_url: '' })
    }
    return terminal(args, options)
  }
}

export const accountCaptureAccounts = {
  alice: { host: 'github.com', user: 'alice' },
  bob: { host: 'github.com', user: 'bob' }
}
export const accountCaptureRepo: Repo = {
  id: 'clone',
  path: '/clone',
  displayName: 'Clone',
  badgeColor: '',
  addedAt: 0,
  executionHostId: 'runtime:account-capture',
  ghAccount: accountCaptureAccounts.alice
}
