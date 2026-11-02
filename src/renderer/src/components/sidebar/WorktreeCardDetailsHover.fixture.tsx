import { defineFixture } from '../../component-fixtures/component-fixture'
import { WorktreeCardDetailsHover } from './WorktreeCardMeta'
import { useWorktreeCardDetailsHoverControl } from './worktree-card-details-hover-state'
import type { WorktreeCardDetailsHoverProps } from './worktree-card-meta-types'
import type { WorkspaceAttachment, Worktree } from '../../../../shared/worktree/types'
import { makeWorktree } from '../worktree-jump-palette-test-fixtures'

const noop = (): void => {}

const issue = {
  number: 14882,
  title:
    '[Bug]: Renderer compositor thread spins at ~100% of one core for hours, producing no frames - recovered by minimize/restore',
  state: 'open' as const,
  url: 'https://github.com/stablyai/orca/issues/14882',
  labels: ['bug', 'os:Windows']
}

const review = {
  provider: 'github' as const,
  number: 37162,
  title: 'perf(renderer): pause long-lived status animations offscreen and honor reduced motion',
  state: 'merged' as const,
  status: 'success' as const,
  url: 'https://github.com/stablyai/orca/pull/37162'
}

const linearIssue = {
  identifier: 'ORC-412',
  title: 'Sidebar hovercard should summarize linked tasks without crowding the PR row',
  url: 'https://linear.app/orca/issue/ORC-412',
  stateName: 'In Progress',
  stateType: 'started',
  labels: ['design', 'sidebar']
}

const jiraIssue = {
  identifier: 'PLAT-2087',
  title: 'Rotate staging webhook signing secrets',
  url: 'https://orca.atlassian.net/browse/PLAT-2087'
}

function workspaceWith(linkedItems: WorkspaceAttachment[]): Worktree {
  return makeWorktree('repo-1::/tmp/fixture', 'Fixture', { linkedItems })
}

function OpenHover(
  props: Omit<WorktreeCardDetailsHoverProps, 'children' | 'comment' | 'hoverControl'> & {
    comment?: string | null
  }
): React.JSX.Element {
  const control = useWorktreeCardDetailsHoverControl()
  return (
    <div style={{ height: 420 }}>
      <WorktreeCardDetailsHover
        comment={null}
        {...props}
        hoverControl={{ ...control, hoverOpen: true }}
        openDelay={0}
      >
        <span style={{ display: 'inline-block', width: 1, height: 1 }} />
      </WorktreeCardDetailsHover>
    </div>
  )
}

export const githubIssueWithReview = defineFixture({
  width: 400,
  render: () => (
    <OpenHover
      issue={issue}
      linearIssue={null}
      review={review}
      onManageLinks={noop}
      onEditIssue={noop}
      onOpenGitHubIssueInOrca={noop}
      onOpenIssueInBrowser={noop}
      onOpenReviewInOrca={noop}
      onUnlinkReview={noop}
    />
  )
})

export const linearIssueWithReview = defineFixture({
  width: 400,
  render: () => (
    <OpenHover
      issue={null}
      linearIssue={linearIssue}
      review={{ ...review, state: 'open', status: 'pending' }}
      onManageLinks={noop}
      onOpenLinearIssueInOrca={noop}
      onOpenReviewInOrca={noop}
    />
  )
})

export const jiraIssueOnly = defineFixture({
  width: 400,
  render: () => (
    <OpenHover
      issue={null}
      linearIssue={null}
      jiraIssue={jiraIssue}
      review={null}
      onManageLinks={noop}
    />
  )
})

export const closedIssueManyLabels = defineFixture({
  width: 400,
  render: () => (
    <OpenHover
      issue={{
        ...issue,
        number: 9021,
        state: 'closed',
        title: 'Terminal paste drops trailing newline',
        labels: ['bug', 'terminal', 'good first issue', 'needs-repro', 'os:Linux', 'priority:high']
      }}
      linearIssue={null}
      review={null}
      onManageLinks={noop}
      onEditIssue={noop}
      onOpenGitHubIssueInOrca={noop}
      onOpenIssueInBrowser={noop}
    />
  )
})

export const linkedCollection = defineFixture({
  width: 400,
  render: () => (
    <OpenHover
      workspace={workspaceWith([
        { provider: 'github', type: 'issue', number: issue.number, url: issue.url },
        {
          provider: 'linear',
          type: 'issue',
          number: 0,
          identifier: linearIssue.identifier,
          url: linearIssue.url
        },
        { provider: 'github', type: 'pr', number: review.number, url: review.url }
      ])}
      issue={issue}
      linearIssue={linearIssue}
      review={review}
      onManageLinks={noop}
      onOpenReviewInOrca={noop}
    />
  )
})

export const narrowLongMetadata = defineFixture({
  width: 330,
  render: () => (
    <>
      {/* Why: the card is portaled, so frame width alone does not narrow it. */}
      <style>{'[data-slot="hover-card-content"]{width:300px}'}</style>
      <OpenHover
        issue={{
          ...issue,
          url: 'https://github.com/some-very-long-organization-name/an-equally-long-repository/issues/14882',
          labels: ['needs-investigation-from-platform', 'regression', 'p1']
        }}
        linearIssue={{ ...linearIssue, stateName: 'Backlog', stateType: 'backlog' }}
        jiraIssue={jiraIssue}
        review={review}
        onManageLinks={noop}
        onEditIssue={noop}
        onOpenIssueInBrowser={noop}
        onOpenReviewInOrca={noop}
      />
    </>
  )
})

export const longLabels = defineFixture({
  width: 400,
  render: () => (
    <OpenHover
      issue={{
        ...issue,
        url: 'https://github.com/some-very-long-organization-name/an-equally-long-repository/issues/14882',
        labels: ['needs-investigation-from-platform', 'regression', 'p1']
      }}
      linearIssue={null}
      review={null}
      onManageLinks={noop}
      onEditIssue={noop}
    />
  )
})
