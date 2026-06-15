import type { IssueInfo } from '../../../../shared/types'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import type { WorktreeCardDetailsHoverControl } from './worktree-card-details-hover-state'

export type WorktreeCardIssueDisplay =
  | IssueInfo
  | {
      number: number
      title: string
      state?: IssueInfo['state']
      url?: string
      labels?: string[]
    }

export type WorktreeCardLinearIssueDisplay = {
  identifier: string
  title: string
  url?: string
  stateName?: string
  labels?: string[]
}

export type WorktreeCardMetaBadgesProps = {
  issue: WorktreeCardIssueDisplay | null
  linearIssue: WorktreeCardLinearIssueDisplay | null
  review: WorktreeCardPrDisplay | null
  comment: string | null
}

export type WorktreeCardMetaBadgesRootProps = WorktreeCardMetaBadgesProps &
  React.HTMLAttributes<HTMLDivElement>

export type WorktreeCardDetailsHoverProps = WorktreeCardMetaBadgesProps & {
  children: React.ReactElement
  branchName?: string
  workspaceTitle?: string
  detailsAfter?: React.ReactNode
  openDelay?: number
  closeDelay?: number
  onEditIssue?: (event: React.MouseEvent) => void
  onEditComment?: (event: React.MouseEvent) => void
  onOpenGitHubIssueInOrca?: (event: React.MouseEvent) => void
  onOpenLinearIssueInOrca?: (event: React.MouseEvent) => void
  onOpenReviewInOrca?: (event: React.MouseEvent) => void
  onUnlinkReview?: () => void
  hoverControl?: WorktreeCardDetailsHoverControl
}
