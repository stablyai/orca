import { defineFixture } from '../../../../component-fixtures/component-fixture'
import {
  azureDevOpsChecksToPRChecks,
  azureDevOpsThreadsToPRComments
} from '../../../../../../shared/source-control/checks/azure-devops/azure-devops-pr-checks'
import { PRCommentsList } from '../comments/comments-list'
import { AzureDevOpsReviewers } from './azure-devops-reviewers'
import { ChecksList } from './checks-list'

const reviewers = [
  {
    displayName: 'Dana Reviewer',
    uniqueName: 'dana@contoso.example',
    vote: 0,
    voteLabel: 'no-vote',
    isRequired: false,
    isGroup: false,
    isMe: true
  },
  {
    displayName: 'Sam Approver',
    uniqueName: 'sam@contoso.example',
    vote: 10,
    voteLabel: 'approved',
    isRequired: true,
    isGroup: false,
    isMe: false
  },
  {
    displayName: 'Platform Team',
    uniqueName: null,
    vote: 5,
    voteLabel: 'approved-with-suggestions',
    isRequired: false,
    isGroup: true,
    isMe: false
  },
  {
    displayName: 'Lee Builder',
    uniqueName: 'lee@contoso.example',
    vote: -5,
    voteLabel: 'waiting-for-author',
    isRequired: false,
    isGroup: false,
    isMe: false
  }
] as const

const checks = azureDevOpsChecksToPRChecks([
  {
    name: 'ci-build',
    kind: 'build',
    status: 'approved',
    isBlocking: true,
    buildId: 1201,
    isStale: false,
    builtCommit: null,
    url: 'https://dev.azure.com/contoso/_build/results?buildId=1201'
  },
  {
    name: 'Minimum number of reviewers',
    kind: 'policy',
    status: 'rejected',
    isBlocking: true,
    buildId: null,
    isStale: false,
    builtCommit: null,
    url: null
  },
  {
    name: 'Required reviewers',
    kind: 'policy',
    status: 'queued',
    isBlocking: true,
    buildId: null,
    isStale: false,
    builtCommit: null,
    url: null
  },
  {
    name: 'security/sast',
    kind: 'status',
    status: 'succeeded',
    isBlocking: false,
    buildId: null,
    isStale: false,
    builtCommit: null,
    url: null
  }
])

const comments = azureDevOpsThreadsToPRComments([
  {
    id: 11,
    status: 'active',
    filePath: '/src/payments/retry.ts',
    line: 42,
    comments: [
      {
        id: 1,
        parentId: null,
        author: 'Sam Approver',
        publishedDate: '2026-11-20T10:00:00Z',
        content: 'This retries non-idempotent calls. Can we key it by request id?'
      },
      {
        id: 2,
        parentId: 1,
        author: 'Dana Reviewer',
        publishedDate: '2026-11-20T11:30:00Z',
        content: 'Agreed, the key exists in the header already.'
      }
    ]
  },
  {
    id: 12,
    status: 'fixed',
    filePath: null,
    line: null,
    comments: [
      {
        id: 1,
        parentId: null,
        author: 'Lee Builder',
        publishedDate: '2026-11-19T09:00:00Z',
        content: 'Please add the changelog entry.'
      }
    ]
  }
])

export const azureDevOpsReadOnlyReview = defineFixture({
  width: 320,
  render: () => (
    <div className="bg-background text-foreground">
      <AzureDevOpsReviewers reviewers={[...reviewers]} />
      <ChecksList
        checks={checks}
        checksLoading={false}
        checkDetailsContextKey="fixture:azure-devops"
      />
      <PRCommentsList
        comments={comments}
        commentsLoading={false}
        reviewKind="PR"
        commentsDisabled
      />
    </div>
  )
})
