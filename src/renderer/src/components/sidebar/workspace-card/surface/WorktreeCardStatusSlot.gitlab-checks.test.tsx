import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { WorktreeCardStatusSlot } from './WorktreeCardStatusSlot'
import { getWorktreeCardPrDisplay } from '../review/worktree-card-pr-display'
import { gitlabMrCheckCases } from '../../../../../../shared/source-control/checks/gitlab/gitlab-mr-checks.test-fixture'
import { buildParentPrChecksProjection } from '../../../right-sidebar/hosted-review/folder-checks/parent-pr-checks-rows'
import { FolderWorkspacePrChecksRow } from '../../../right-sidebar/hosted-review/folder-checks/FolderWorkspacePrChecksRow'
import { presentGitLabMRMergeState } from '../../../right-sidebar/hosted-review/provider-actions/gitlab-mr-merge-state'
import { getActiveChecksStatus } from '../../../right-sidebar/checks-panel/active-checks-status'
import {
  ReviewChecksBadge,
  ReviewChecksIndicator
} from '../metadata/WorktreeCardMetadataStatusBadges'
import { WorktreeReferenceStack } from '../review/WorktreeReferenceStack'
import type { WorkspaceReferenceDetailsMap } from '../review/workspace-reference-details'
import { getFolderWorkspaceCardPrDisplay } from '../review/folder-workspace-card-pr-display'
import { formatHostedReviewLabel } from '../../../status-bar/hosted-review-label'
import { reviewRefreshIntervalMs } from '../../../../../../shared/review-refresh-policy'
import { summarizeWorkspaceReviewChecks } from '../../../../../../shared/workspace-review-checks'
import { getWorkspaceAttachmentKey } from '../../../../../../shared/workspace-attachments/workspace-attachment-normalization'
import {
  referenceRepo,
  referenceWorkspace
} from '../review/workspace-reference-fixtures.test-support'

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

vi.mock('../activity/use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => mocks.status
}))

vi.mock('../../workspace-actions/sleep/use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => mocks.sleeping
}))

describe('WorktreeCardStatusSlot', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })
  beforeEach(() => {
    mocks.status = 'active'
    mocks.sleeping = false
  })

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
})
