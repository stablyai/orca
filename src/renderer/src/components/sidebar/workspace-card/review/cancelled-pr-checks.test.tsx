import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import ko from '@/i18n/locales/ko.json'
import { CircleCheck } from 'lucide-react'
import {
  summarizeProviderChecks,
  getProviderChecksOutcome
} from '../../../../../../shared/source-control/checks/provider-check-summary'
import { summarizeWorkspaceReviewChecks } from '../../../../../../shared/workspace-review-checks'
import { getWorkspaceAttachmentKey } from '../../../../../../shared/workspace-attachments/workspace-attachment-normalization'
import type { GitHubWorkItem } from '../../../../../../shared/github/work-item-types'
import { PRChecksCell } from '../../../task-page/github/ChecksCell'
import {
  ActivityBarButton,
  TopActivityOverflowMenu
} from '../../../right-sidebar/activity-bar-buttons'
import {
  WorkspaceReviewChecksIndicator,
  workspaceReviewChecksLabel
} from '../../WorkspaceReviewChecksIndicator'
import { ReviewChecksIndicator } from '../metadata/WorktreeCardMetadataStatusBadges'
import { WorktreeCardStatusSlot } from '../surface/WorktreeCardStatusSlot'
import { buildParentPrChecksProjection } from '../../../right-sidebar/parent-pr-checks-rows'
import { FolderWorkspacePrChecksRow } from '../../../right-sidebar/FolderWorkspacePrChecksRow'
import { getFolderWorkspaceCardPrDisplay } from './folder-workspace-card-pr-display'
import {
  referenceAttachment,
  referenceReview,
  referenceRepo,
  referenceWorkspace
} from './workspace-reference-fixtures.test-support'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))
vi.mock('../activity/use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'done'
}))
vi.mock('../../workspace-actions/sleep/use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => false
}))

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('cancelled PR aggregate rendering', () => {
  it.each([
    [['cancelled', 'success'], 'Cancelled', 'text-muted-foreground'],
    [['cancelled', 'failure'], 'Failing', 'text-rose-500'],
    [['cancelled', 'pending'], 'Pending', 'text-amber-500']
  ] as const)('renders %j consistently on real aggregate surfaces', (conclusions, label, tone) => {
    const checksSummary = summarizeProviderChecks(
      conclusions.map((conclusion) => ({ status: 'completed', conclusion }))
    )
    const review = referenceReview(7, { status: 'failure', checksSummary })
    const badge = renderToStaticMarkup(
      <ReviewChecksIndicator status={review.status} checksSummary={checksSummary} />
    )
    expect(badge).toContain(`Checks: ${label}`)
    expect(badge).toContain(tone)
    const item: GitHubWorkItem = {
      id: 'pr:7',
      repoId: 'repo',
      type: 'pr',
      number: 7,
      title: '',
      state: 'open',
      url: review.url,
      labels: [],
      updatedAt: '',
      author: null,
      checksSummary
    }
    const pill = renderToStaticMarkup(
      <PRChecksCell item={item} onOpen={() => {}} onLoadChecks={() => {}} />
    )
    expect(pill).toContain(
      label === 'Failing' ? '1 failing' : label === 'Pending' ? '1 pending' : 'Cancelled'
    )
    expect(pill).toContain(
      label === 'Failing' ? 'rose' : label === 'Pending' ? 'amber' : 'text-muted-foreground'
    )
    const outcome = getProviderChecksOutcome(checksSummary, 'failure')
    const activityItem = { id: 'checks' as const, icon: CircleCheck, title: 'Checks', shortcut: '' }
    const activity = renderToStaticMarkup(
      <ActivityBarButton
        item={activityItem}
        active={false}
        layout="top"
        onClick={() => {}}
        statusIndicator={outcome}
      />
    )
    const overflow = renderToStaticMarkup(
      <TopActivityOverflowMenu
        items={[activityItem]}
        activeTab="checks"
        onSelect={() => {}}
        checksStatus={outcome}
      />
    )
    for (const markup of [activity, overflow]) {
      expect(markup).toContain(
        outcome === 'failure'
          ? 'bg-rose'
          : outcome === 'pending'
            ? 'bg-amber'
            : 'bg-muted-foreground'
      )
      if (outcome === 'cancelled') {
        expect(markup).toContain('Cancelled')
        expect(markup).not.toContain('Error')
      }
    }
    const context = {
      worktrees: [referenceWorkspace],
      repos: [referenceRepo],
      settings: null,
      hostedReviewCache: {
        'local::repo::feature': { data: review, fetchedAt: 1, linkedReviewHintKey: 'github:7' }
      },
      prCache: {},
      checksCache: {}
    }
    const projection = buildParentPrChecksProjection(context)
    const row = renderToStaticMarkup(
      <FolderWorkspacePrChecksRow
        row={projection.rows[0]}
        expanded={false}
        onToggle={() => {}}
        onLoadCheckDetails={async () => null}
      />
    )
    expect(row).toContain(
      label === 'Failing' ? 'Checks failing' : label === 'Pending' ? 'Checks pending' : label
    )
    if (label === 'Cancelled') {
      expect(row).not.toContain('rose')
    }
    const passingSibling = {
      ...referenceWorkspace,
      id: 'passing-sibling',
      branch: 'passing',
      linkedPR: 8
    }
    const folderReview = getFolderWorkspaceCardPrDisplay({
      ...context,
      folderWorkspaceId: 'folder',
      worktreeMap: new Map([
        [passingSibling.id, passingSibling],
        [referenceWorkspace.id, referenceWorkspace]
      ]),
      hostedReviewCache: {
        ...context.hostedReviewCache,
        'local::repo::passing': {
          data: referenceReview(8),
          fetchedAt: 1,
          linkedReviewHintKey: 'github:8'
        }
      },
      repoMap: new Map([['repo', referenceRepo]]),
      worktreeLineageById: {},
      workspaceLineageByChildKey: {
        passing: {
          childWorkspaceKey: `worktree:${passingSibling.id}`,
          parentWorkspaceKey: 'folder:folder',
          origin: 'cli',
          capture: { source: 'env-workspace', confidence: 'inferred' },
          createdAt: 1
        },
        child: {
          childWorkspaceKey: `worktree:${referenceWorkspace.id}`,
          parentWorkspaceKey: 'folder:folder',
          origin: 'cli',
          capture: { source: 'env-workspace', confidence: 'inferred' },
          createdAt: 1
        }
      }
    })
    expect(folderReview?.number).toBe(7)
    expect(folderReview?.checksSummary).toEqual(checksSummary)
    const folderBadge = renderToStaticMarkup(
      <ReviewChecksIndicator
        status={folderReview?.status}
        checksSummary={folderReview?.checksSummary}
      />
    )
    expect(folderBadge).toContain(`Checks: ${label}`)
    const attachment = referenceAttachment(7)
    const details = { [getWorkspaceAttachmentKey(attachment)]: { review } }
    const collection = summarizeWorkspaceReviewChecks([attachment], details)
    expect(renderToStaticMarkup(<WorkspaceReviewChecksIndicator summary={collection} />)).toContain(
      'text-emerald-500/80'
    )
    expect(workspaceReviewChecksLabel(collection)).toContain(label === 'Failing' ? 'Failed' : label)
  })

  it('uses the existing translated cancellation label and retains merged lifecycle purple', async () => {
    i18n.addResourceBundle('ko', 'translation', ko, true, true)
    await i18n.changeLanguage('ko')
    const checksSummary = summarizeProviderChecks([
      { status: 'completed', conclusion: 'cancelled' }
    ])
    const markup = renderToStaticMarkup(
      <ReviewChecksIndicator status="failure" checksSummary={checksSummary} />
    )
    expect(markup).toContain(ko.auto.components.editor.CheckRunDetailsPanel['91a4c7e2b0'])
    await i18n.changeLanguage('en')
    const merged = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip=""
        onToggleUnread={() => {}}
        onPointerDown={() => {}}
        newCardStyle
        prDisplay={referenceReview(7, { state: 'merged', status: 'failure', checksSummary })}
      />
    )
    expect(merged).toContain('text-purple')
  })
})
