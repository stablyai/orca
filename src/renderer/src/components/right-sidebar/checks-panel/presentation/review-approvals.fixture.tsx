import type { PRInfo } from '../../../../../../shared/github/pull-requests/pull-request-types'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { ChecksPanelReviewApprovals } from './review-approvals'
import { ChecksList } from './checks-list'

function avatar(fill: string): string {
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${fill}"/></svg>`
  )}`
}

const pr: PRInfo = {
  number: 42,
  title: 'Show who approved in the Checks panel',
  state: 'open',
  url: 'https://github.com/acme/widgets/pull/42',
  checksStatus: 'success',
  updatedAt: '2026-11-16T09:00:00Z',
  mergeable: 'MERGEABLE',
  reviewDecision: 'REVIEW_REQUIRED'
}

const checks = [
  { name: 'build', status: 'completed', conclusion: 'success', url: null },
  { name: 'unit tests', status: 'completed', conclusion: 'success', url: null }
] as const

function Panel({ review }: { review: PRInfo }): React.JSX.Element {
  return (
    <div className="bg-background text-foreground">
      <ChecksPanelReviewApprovals pr={review} />
      <ChecksList
        checks={[...checks]}
        checksLoading={false}
        checkDetailsContextKey="fixture:review-approvals"
        onLoadCheckDetails={async () => null}
      />
    </div>
  )
}

export const codeOwnerTeamPending = defineFixture({
  width: 305,
  render: () => (
    <Panel
      review={{
        ...pr,
        reviewRequests: [{ login: 'riley-dev', name: 'Riley Park', avatarUrl: avatar('#7c9cbf') }],
        teamReviewRequests: [{ slug: 'acme/mobile-owners', name: 'Mobile owners' }],
        latestReviews: [
          { login: 'sam-ops', state: 'APPROVED', avatarUrl: avatar('#8fbf7c') },
          { login: 'alex-qa', state: 'COMMENTED', avatarUrl: avatar('#bf9f7c') }
        ]
      }}
    />
  )
})

export const changesRequested = defineFixture({
  width: 305,
  render: () => (
    <Panel
      review={{
        ...pr,
        reviewDecision: 'CHANGES_REQUESTED',
        reviewRequests: [],
        teamReviewRequests: [],
        latestReviews: [
          { login: 'sam-ops', state: 'APPROVED', avatarUrl: avatar('#8fbf7c') },
          { login: 'jo-sec', state: 'CHANGES_REQUESTED', avatarUrl: avatar('#bf7c8f') }
        ]
      }}
    />
  )
})

export const unnamedTeamRequest = defineFixture({
  width: 305,
  render: () => (
    <Panel
      review={{
        ...pr,
        reviewRequests: [],
        teamReviewRequests: [],
        unnamedReviewRequestCount: 1,
        latestReviews: [{ login: 'sam-ops', state: 'APPROVED', avatarUrl: avatar('#8fbf7c') }]
      }}
    />
  )
})

export const onlyUnnamedRequest = defineFixture({
  width: 305,
  render: () => (
    <Panel
      review={{
        ...pr,
        reviewRequests: [],
        teamReviewRequests: [],
        unnamedReviewRequestCount: 1,
        latestReviews: []
      }}
    />
  )
})

export const noReviewersRequested = defineFixture({
  width: 305,
  render: () => (
    <Panel review={{ ...pr, reviewRequests: [], teamReviewRequests: [], latestReviews: [] }} />
  )
})

export const reviewersUnknown = defineFixture({
  width: 305,
  render: () => <Panel review={pr} />
})
