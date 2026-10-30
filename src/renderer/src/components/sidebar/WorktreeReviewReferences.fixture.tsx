import { useEffect } from 'react'
import WorktreeCard from './WorktreeCard'
import type { Repo } from '../../../../shared/repo-types'
import { getDefaultSettings } from '../../../../shared/constants'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorkspaceAttachmentKey } from '../../../../shared/workspace-attachment-normalization'
import { WorktreeCardDetailsHover, WorktreeCardMetaBadges } from './WorktreeCardMeta'
import { useWorktreeCardDetailsHoverControl } from './worktree-card-details-hover-state'
import { getWorkspaceCardAttachments } from './workspace-hover-attachments'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { WorkspaceReferenceDetailsMap } from './workspace-reference-details'

const workspace: Worktree = {
  id: 'repo::/repo/reland-stable-tabs',
  repoId: 'repo',
  path: '/repo/reland-stable-tabs',
  displayName: 'reland-stable-tabs',
  branch: 'AmethystLiang/reland-stable-tabs',
  head: 'head',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  linkedItems: [
    {
      provider: 'github',
      type: 'pr',
      number: 34025,
      url: 'https://github.com/stablyai/orca/pull/34025',
      origins: [{ kind: 'observed', tabId: 'terminal', label: 'Terminal 2' }]
    }
  ],
  isBare: false,
  isMainWorktree: false,
  isArchived: false,
  isUnread: false,
  isPinned: true,
  sortOrder: 0,
  lastActivityAt: 1
}
const review: HostedReviewInfo = {
  provider: 'github',
  number: 34527,
  title: 'Reland title-sized tabs as an experiment that holds widths through agent renames',
  url: 'https://github.com/stablyai/orca/pull/34527',
  state: 'open',
  status: 'failure',
  updatedAt: '',
  mergeable: 'MERGEABLE'
}
const items = getWorkspaceCardAttachments(workspace, review)
const details: WorkspaceReferenceDetailsMap = Object.fromEntries(
  items.map((item) => [
    getWorkspaceAttachmentKey(item),
    item.number === review.number
      ? { title: review.title, url: review.url ?? '', review }
      : {
          title: 'Size tabs to titles and preserve floating panel drag space',
          url: item.url ?? '',
          review: {
            ...review,
            number: item.number,
            url: item.url ?? '',
            state: 'merged',
            status: 'success'
          }
        }
  ])
)

function ReviewReferences(): React.JSX.Element {
  const hoverControl = useWorktreeCardDetailsHoverControl()
  const { handleHoverOpenChange } = hoverControl
  useEffect(() => handleHoverOpenChange(true), [handleHoverOpenChange])
  return (
    <div className="h-80 p-3">
      <WorktreeCardDetailsHover
        workspace={workspace}
        review={review}
        referenceDetails={details}
        issue={null}
        linearIssue={null}
        comment={null}
        hoverControl={hoverControl}
      >
        <div className="flex w-64 items-center gap-2 rounded-md bg-sidebar-accent p-2 text-xs">
          <span className="flex-1 truncate">{workspace.displayName}</span>
          <WorktreeCardMetaBadges
            linkedItemCount={items.length}
            referenceItems={items}
            referenceDetails={details}
            review={null}
            issue={null}
            linearIssue={null}
            comment={null}
          />
        </div>
      </WorktreeCardDetailsHover>
    </div>
  )
}

export const observedAndBranchReview = defineFixture({
  width: 820,
  render: () => <ReviewReferences />
})

const repo: Repo = {
  id: workspace.repoId,
  path: '/repo',
  displayName: 'Orca',
  badgeColor: '',
  addedAt: 1,
  gitRemoteIdentity: {
    canonicalKey: 'github.com/stablyai/orca',
    remoteName: 'origin',
    remoteUrl: 'https://github.com/stablyai/orca.git'
  }
}

export const cardWithObservedAndBranchReview = defineFixture({
  width: 320,
  store: {
    settings: {
      ...getDefaultSettings('/home/fixture'),
      compactWorktreeCards: true,
      experimentalNewWorktreeCardStyle: true
    },
    worktreeCardProperties: ['status', 'pr'],
    repos: [repo],
    worktreesByRepo: { [repo.id]: [workspace] },
    hostedReviewCache: {
      [`local::${repo.id}::${workspace.branch}`]: {
        data: review,
        fetchedAt: Date.now(),
        linkedReviewHintKey: ''
      }
    }
  },
  render: () => (
    <div className="bg-sidebar p-3 text-sidebar-foreground">
      <WorktreeCard worktree={workspace} repo={repo} isActive={false} />
    </div>
  ),
  interact: (frame) => {
    const count = frame.querySelector('[data-reference-count]')
    if (!(count instanceof HTMLElement) || count.textContent !== '2') {
      throw new Error('Expected the saved and branch review stack')
    }
    const bounds = count.getBoundingClientRect()
    for (let parent = count.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent)
      const parentBounds = parent.getBoundingClientRect()
      if (
        ((style.overflowX === 'hidden' || style.overflowX === 'clip') &&
          (bounds.left < parentBounds.left || bounds.right > parentBounds.right)) ||
        ((style.overflowY === 'hidden' || style.overflowY === 'clip') &&
          (bounds.top < parentBounds.top || bounds.bottom > parentBounds.bottom))
      ) {
        throw new Error('Review stack count is clipped by a card ancestor')
      }
    }
  }
})
