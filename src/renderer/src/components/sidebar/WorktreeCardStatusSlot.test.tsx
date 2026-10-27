import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreeCardStatusSlot } from './WorktreeCardStatusSlot'
import { getWorktreeCardPrDisplay, type WorktreeCardPrDisplay } from './worktree-card-pr-display'
import { gitlabMrCheckCases } from '../../../../shared/gitlab-mr-checks.test-fixture'
import { buildParentPrChecksProjection } from '../right-sidebar/parent-pr-checks-rows'
import { FolderWorkspacePrChecksRow } from '../right-sidebar/FolderWorkspacePrChecksRow'
import { presentGitLabMRMergeState } from '../right-sidebar/gitlab-mr-merge-state'
import { getActiveChecksStatus } from '../right-sidebar/active-checks-status'
import { ReviewChecksBadge, ReviewChecksIndicator } from './WorktreeCardMetadataStatusBadges'
import { WorktreeReferenceStack } from './WorktreeReferenceStack'
import type { WorkspaceReferenceDetailsMap } from './workspace-reference-details'
import { getFolderWorkspaceCardPrDisplay } from './folder-workspace-card-pr-display'
import { formatHostedReviewLabel } from '../status-bar/hosted-review-label'
import { reviewRefreshIntervalMs } from '../../../../shared/review-refresh-policy'
import { summarizeWorkspaceReviewChecks } from '../../../../shared/workspace-review-checks'
import { getWorkspaceAttachmentKey } from '../../../../shared/workspace-attachment-normalization'
import {
  referenceAttachment,
  referenceReview,
  referenceRepo,
  referenceWorkspace
} from './workspace-reference-fixtures.test-support'

const mocks = vi.hoisted(() => ({
  status: 'active',
  sleeping: false
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <span data-tooltip-root="">{children}</span>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <span data-tooltip-content="">{children}</span>
  ),
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('./use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => mocks.status
}))

vi.mock('./use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => mocks.sleeping
}))

describe('WorktreeCardStatusSlot', () => {
  beforeEach(() => {
    mocks.status = 'active'
    mocks.sleeping = false
  })

  const review: WorktreeCardPrDisplay = {
    provider: 'github',
    number: 123,
    title: 'Review me',
    state: 'open',
    status: 'failure'
  }
  const gitlabReview: WorktreeCardPrDisplay = {
    provider: 'gitlab',
    number: 456,
    title: 'Review me',
    state: 'open',
    status: 'pending'
  }

  it.each(gitlabMrCheckCases)(
    'presents the normalized $name without claiming passing',
    ({ review: mapped, cardLabel, tone, rowSummary, mergeLabel, directMergeAvailable }) => {
      const { status } = mapped
      const worktree = { ...referenceWorkspace, linkedPR: null, linkedGitLabMR: 7 }
      const hostedReviewCache = {
        'local::repo::feature': { data: mapped, fetchedAt: 1, linkedReviewHintKey: 'gitlab:7' }
      }
      const context = {
        worktrees: [worktree],
        repos: [referenceRepo],
        settings: null,
        hostedReviewCache,
        prCache: {},
        checksCache: {}
      }
      const projection = buildParentPrChecksProjection(context)
      const card = renderToStaticMarkup(
        <WorktreeCardStatusSlot
          worktreeId={worktree.id}
          showStatus
          showUnreadAction={false}
          isUnread={false}
          unreadTooltip=""
          onPointerDown={vi.fn()}
          onToggleUnread={vi.fn()}
          newCardStyle
          prDisplay={getWorktreeCardPrDisplay(mapped, null, 7)}
        />
      )
      expect(card).toContain(cardLabel)
      expect(card).toContain(tone)
      expect(card).not.toContain('Passing')
      const row = renderToStaticMarkup(
        <FolderWorkspacePrChecksRow
          row={projection.rows[0]}
          expanded={false}
          onToggle={vi.fn()}
          onLoadCheckDetails={async () => null}
        />
      )
      expect(row).toContain(rowSummary)
      expect(row).not.toMatch(/Checks passing|lucide-circle-check/)
      expect(projection.summary.passing).toBe(0)
      expect(presentGitLabMRMergeState(mapped)).toMatchObject({
        label: mergeLabel,
        directMergeAvailable
      })
      expect(
        getActiveChecksStatus({
          ...context,
          activeWorktreeId: worktree.id,
          worktreesByRepo: { repo: [worktree] }
        })
      ).toBe(status)
      const item = { provider: 'gitlab', type: 'mr', number: 7 } as const
      const details = {
        [getWorkspaceAttachmentKey(item)]: { title: mapped.title, url: mapped.url, review: mapped }
      } satisfies WorkspaceReferenceDetailsMap
      expect(summarizeWorkspaceReviewChecks([item], details)).toMatchObject({
        state: status,
        passed: 0
      })
      expect(
        renderToStaticMarkup(<WorktreeReferenceStack items={[item]} details={details} />)
      ).toContain(tone)
      const checkLabel = { failure: 'Failing', pending: 'Pending', neutral: '' }[status]
      for (const Badge of [ReviewChecksBadge, ReviewChecksIndicator]) {
        const badge = renderToStaticMarkup(<Badge status={mapped.status} />)
        expect(badge).toEqual(checkLabel ? expect.stringContaining(`Checks: ${checkLabel}`) : '')
      }
      expect(
        getFolderWorkspaceCardPrDisplay({
          ...context,
          folderWorkspaceId: 'folder',
          worktreeMap: new Map([[worktree.id, worktree]]),
          repoMap: new Map([['repo', referenceRepo]]),
          worktreeLineageById: {},
          workspaceLineageByChildKey: {
            child: {
              childWorkspaceKey: `worktree:${worktree.id}`,
              parentWorkspaceKey: 'folder:folder',
              origin: 'cli',
              capture: { source: 'env-workspace', confidence: 'inferred' },
              createdAt: 1
            }
          }
        })
      ).toMatchObject({ state: 'open', status })
      expect(formatHostedReviewLabel(mapped)).toBe(`MR !7 Open, ${status}`)
      expect(reviewRefreshIntervalMs({ state: mapped.state, checksStatus: mapped.status })).toBe(
        120_000
      )
      expect(reviewRefreshIntervalMs({ state: 'merged', checksStatus: mapped.status })).toBe(
        status === 'pending' ? 60_000 : null
      )
    }
  )

  it('uses checks from every attached review rather than the legacy passing review', () => {
    const items = [referenceAttachment(1), referenceAttachment(2)]
    const details = Object.fromEntries(
      items.map((item) => [
        getWorkspaceAttachmentKey(item),
        {
          review: referenceReview(item.number, {
            status: item.number === 1 ? 'success' : 'failure'
          })
        }
      ])
    )
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip=""
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        newCardStyle
        prDisplay={{ ...review, status: 'success' }}
        reviewChecks={summarizeWorkspaceReviewChecks(items, details)}
      />
    )
    expect(markup).toContain('Reviews: 2 · Checks: Failed')
    expect(markup).toContain('text-rose-500/85')
    expect(markup).not.toContain('checks: Passing')
  })
  it('keeps incomplete collection checks neutral instead of claiming passing', () => {
    const items = [referenceAttachment(1), referenceAttachment(2)]
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip=""
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        newCardStyle
        prDisplay={{ ...review, status: 'success' }}
        reviewChecks={summarizeWorkspaceReviewChecks(items, {})}
      />
    )
    expect(markup).toContain('Reviews: 2 · Checks: Unknown')
    expect(markup).toContain('text-muted-foreground')
    expect(markup).not.toContain('text-emerald-500')
  })
  it.each([{ items: [] }, { items: [referenceAttachment(1)] }])(
    'preserves discovered and singleton review lifecycle glyphs',
    ({ items }) => {
      const markup = renderToStaticMarkup(
        <WorktreeCardStatusSlot
          worktreeId="wt-1"
          showStatus
          showUnreadAction={false}
          isUnread={false}
          unreadTooltip=""
          onPointerDown={vi.fn()}
          onToggleUnread={vi.fn()}
          newCardStyle
          prDisplay={{ ...review, state: 'draft' }}
          reviewChecks={summarizeWorkspaceReviewChecks(items, {})}
        />
      )
      expect(markup).toContain('PR: Draft')
      expect(markup).toContain('lucide-git-pull-request-draft')
      expect(markup).not.toContain('Reviews:')
    }
  )

  it('lets the unread bell replace the visual status dot by default', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread
        unreadTooltip="Mark as read"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
      />
    )

    expect(markup).toContain('aria-label="Mark as read"')
    expect(markup).toContain('Mark as read')
    expect(markup).not.toContain('Active · Mark as read')
    expect(markup).not.toContain('bg-emerald-500')
    expect(markup).toContain('text-amber-500')
  })

  it('overlays an unread badge on the status dot when new card style is on', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread
        unreadTooltip="Mark as read"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        newCardStyle
      />
    )

    expect(markup).not.toContain('aria-label="Mark as read"')
    expect(markup).not.toContain('Mark as read')
    expect(markup).toContain('Active · Unread')
    expect(markup).toContain('data-worktree-status-lane-unread=""')
    expect(markup).toContain('data-worktree-unread-alert=""')
    expect(markup).toContain('bg-amber-500')
    expect(markup).toContain('bg-emerald-500')
    expect(markup).not.toContain('lucide-bell')
    expect(markup).not.toContain('text-amber-500')
  })

  it('suppresses the new-card unread badge while unread status is working', () => {
    mocks.status = 'working'
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread
        unreadTooltip="Mark as read"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        newCardStyle
      />
    )

    expect(markup).toContain('Working · Unread')
    expect(markup).toContain('border-agent-working')
    expect(markup).not.toContain('data-worktree-status-lane-unread=""')
    expect(markup).not.toContain('data-worktree-unread-alert=""')
    expect(markup).not.toContain('aria-label="Mark as read"')
    expect(markup).not.toContain('lucide-bell')
    expect(markup).not.toContain('text-amber-500')
  })

  it('suppresses the new-card unread badge while unread status is permission', () => {
    mocks.status = 'permission'
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread
        unreadTooltip="Mark as read"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        newCardStyle
      />
    )

    expect(markup).toContain('Needs permission · Unread')
    expect(markup).toContain('lucide-message-circle-question-mark')
    expect(markup).toContain('text-agent-question')
    expect(markup).not.toContain('data-worktree-status-lane-unread=""')
    expect(markup).not.toContain('data-worktree-unread-alert=""')
    expect(markup).not.toContain('aria-label="Mark as read"')
    expect(markup).not.toContain('lucide-bell')
  })

  it('keeps legacy unread working cards on the unread bell control', () => {
    mocks.status = 'working'
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread
        unreadTooltip="Mark as read"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
      />
    )

    expect(markup).toContain('aria-label="Mark as read"')
    expect(markup).toContain('Mark as read')
    expect(markup).toContain('Working')
    expect(markup).toContain('text-amber-500')
    expect(markup).not.toContain('border-agent-working')
    expect(markup).not.toContain('data-worktree-unread-alert=""')
  })

  it('shows status in the unread toggle affordance', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
      />
    )

    expect(markup).toContain('Active · Mark as unread')
    expect(markup).toContain('bg-emerald-500')
    expect(markup.match(/data-tooltip-root/g)).toHaveLength(1)
  })

  it('keeps the quiet active dot ahead of PR status by default', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={review}
      />
    )

    expect(markup).toContain('Active')
    expect(markup).toContain('bg-emerald-500')
    expect(markup).not.toContain('PR checks: Failed')
  })

  it('uses PR status instead of the quiet active dot when new card style is on', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={review}
        newCardStyle
      />
    )

    expect(markup).toContain('PR checks: Failed')
    expect(markup).toContain('inline-flex size-5 items-center justify-center')
    expect(markup).toContain('size-[13px] translate-x-px')
    expect(markup).toContain('text-rose-500/85')
    expect(markup).not.toContain('bg-emerald-500')
    expect(markup).not.toContain('data-tooltip-root')
  })

  it('marks the review status as last known while its WSL host is off (E9)', () => {
    const render = (reviewStale: boolean) =>
      renderToStaticMarkup(
        <WorktreeCardStatusSlot
          worktreeId="wt-1"
          showStatus
          showUnreadAction={false}
          isUnread={false}
          unreadTooltip="Mark as unread"
          onPointerDown={vi.fn()}
          onToggleUnread={vi.fn()}
          prDisplay={review}
          newCardStyle
          reviewStale={reviewStale}
        />
      )
    const stale = render(true)
    expect(stale).toContain('PR checks: Failed · Last known status')
    expect(stale).toContain('shimmer')
    // The cached badge is kept, not dropped.
    expect(stale).toContain('text-rose-500/85')
    expect(render(false)).not.toContain('Last known status')
  })

  it('uses the unified compact review glyph for GitLab MR status', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={gitlabReview}
        newCardStyle
      />
    )

    expect(markup).toContain('MR checks: Pending')
    expect(markup).toContain('viewBox="0 0 16 16"')
    expect(markup).toContain('size-[13px] translate-x-px')
    expect(markup).toContain('text-amber-500/85')
    expect(markup).not.toContain('lucide-git-merge')
  })

  it('uses PR status instead of the quiet done dot when new card style is on', () => {
    mocks.status = 'done'
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={review}
        newCardStyle
      />
    )

    expect(markup).toContain('PR checks: Failed')
    expect(markup).not.toContain('bg-emerald-500')
  })

  it('keeps sleeping distinct from PR status when new card style is on', () => {
    // Sleeping retains done rows; test that state rather than inactive.
    mocks.status = 'done'
    mocks.sleeping = true
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={review}
        newCardStyle
      />
    )

    expect(markup).toContain('Sleeping')
    expect(markup).toContain('lucide-moon')
    expect(markup).not.toContain('PR checks: Failed')
    expect(markup).not.toContain('text-rose-500/85')
    expect(markup).not.toContain('bg-neutral-500/40')
  })

  it('keeps sleeping moon distinct from the awake green dot when new card style is on', () => {
    mocks.status = 'done'
    mocks.sleeping = true
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        newCardStyle
      />
    )

    expect(markup).toContain('Sleeping')
    expect(markup).toContain('lucide-moon')
    expect(markup).not.toContain('lucide-git-branch')
    expect(markup).not.toContain('bg-emerald-500')
    expect(markup).not.toContain('bg-neutral-500/40')
  })

  it('distinguishes awake branch from sleeping moon when new card style is on', () => {
    mocks.status = 'done'
    const awakeMarkup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        newCardStyle
        hasBranchIdentity
      />
    )
    expect(awakeMarkup).toContain('Branch')
    expect(awakeMarkup).toContain('lucide-git-branch')
    expect(awakeMarkup).not.toContain('lucide-moon')
    mocks.sleeping = true
    const sleepingMarkup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        newCardStyle
        hasBranchIdentity
      />
    )
    expect(sleepingMarkup).toContain('Sleeping')
    expect(sleepingMarkup).toContain('lucide-moon')
    expect(sleepingMarkup).not.toContain('lucide-git-branch')
  })

  it('shows the green awake dot for quiet done workspaces when new card style is on', () => {
    mocks.status = 'done'
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        newCardStyle
      />
    )

    expect(markup).toContain('Done')
    expect(markup).toContain('bg-emerald-500')
    expect(markup).not.toContain('lucide-git-branch')
    expect(markup).not.toContain('lucide-moon')
    expect(markup).toContain('data-tooltip-root')
  })

  it('keeps working activity ahead of PR status in new card style', () => {
    mocks.status = 'working'
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={review}
        newCardStyle
      />
    )

    expect(markup).toContain('Working')
    expect(markup).toContain('inline-flex size-5 items-center justify-center')
    expect(markup).toContain('border-agent-working')
    expect(markup).toContain('data-tooltip-root')
    expect(markup).toContain('data-tooltip-content="">Working')
    expect(markup).not.toContain('PR checks: Failed')
  })

  it('keeps permission activity ahead of PR status in new card style', () => {
    mocks.status = 'permission'
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={review}
        newCardStyle
      />
    )

    expect(markup).toContain('Needs permission')
    expect(markup).toContain('lucide-message-circle-question-mark')
    expect(markup).toContain('text-agent-question')
    expect(markup).toContain('data-tooltip-root')
    expect(markup).toContain('data-tooltip-content="">Needs permission')
    expect(markup).not.toContain('PR checks: Failed')
  })

  it('keeps unread ahead of PR status by default', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread
        unreadTooltip="Mark as read"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={review}
      />
    )

    expect(markup).toContain('aria-label="Mark as read"')
    expect(markup).toContain('Mark as read')
    expect(markup).not.toContain('Active · Mark as read')
    expect(markup).not.toContain('PR checks: Failed')
    expect(markup).not.toContain('bg-emerald-500')
    expect(markup).toContain('text-amber-500')
  })

  it('overlays an unread badge on PR status when new card style is on', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread
        unreadTooltip="Mark as read"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={review}
        newCardStyle
      />
    )

    expect(markup).not.toContain('aria-label="Mark as read"')
    expect(markup).not.toContain('Mark as read')
    expect(markup).toContain('PR checks: Failed · Unread')
    expect(markup).toContain('data-worktree-status-lane-unread=""')
    expect(markup).toContain('data-worktree-unread-alert=""')
    expect(markup).not.toContain('group/unread')
    expect(markup).not.toContain('cursor-pointer')
    expect(markup).toContain('text-rose-500/85')
    expect(markup).toContain('bg-amber-500')
    expect(markup).not.toContain('lucide-bell')
    expect(markup).not.toContain('text-amber-500')
    expect(markup).not.toContain('bg-emerald-500')
    expect(markup).not.toContain('data-tooltip-root')
  })

  it('overlays an unread badge on the sleeping moon in new card style', () => {
    mocks.status = 'done'
    mocks.sleeping = true
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread
        unreadTooltip="Mark as read"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        newCardStyle
      />
    )

    expect(markup).toContain('Sleeping · Unread')
    expect(markup).toContain('data-worktree-status-lane-unread=""')
    expect(markup).toContain('data-worktree-unread-alert=""')
    expect(markup).not.toContain('Mark as read')
    expect(markup).not.toContain('group/unread')
    expect(markup).not.toContain('cursor-pointer')
    expect(markup).toContain('lucide-moon')
    expect(markup).toContain('bg-amber-500')
    expect(markup).not.toContain('lucide-bell')
    expect(markup).not.toContain('text-amber-500')
    expect(markup).not.toContain('bg-emerald-500')
    expect(markup).not.toContain('data-tooltip-root')
  })
})
