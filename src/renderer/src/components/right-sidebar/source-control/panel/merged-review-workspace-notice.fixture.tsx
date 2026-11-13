import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { makeWorktree } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import { SourceControlMergedReviewNotice } from './merged-review-workspace-notice'

const review: HostedReviewInfo = {
  provider: 'github',
  number: 412,
  title: 'Add retry to sync',
  state: 'merged',
  url: 'https://github.com/acme/app/pull/412',
  status: 'success',
  updatedAt: '2026-11-10T00:00:00Z',
  mergeable: 'UNKNOWN',
  headSha: 'a1b2c3d'
}

const worktree = makeWorktree('repo-1::/work/app-sync', 'app-sync', {
  branch: 'refs/heads/feature/sync-retry'
})

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="bg-sidebar p-2 text-foreground">{children}</div>
}

export const safeToDelete = defineFixture({
  width: 300,
  render: () => (
    <Frame>
      <SourceControlMergedReviewNotice
        review={review}
        worktree={worktree}
        statusHeadOid="a1b2c3d"
        uncommittedCount={0}
      />
    </Frame>
  )
})

export const uncommittedChanges = defineFixture({
  width: 300,
  render: () => (
    <Frame>
      <SourceControlMergedReviewNotice
        review={review}
        worktree={worktree}
        statusHeadOid="a1b2c3d"
        uncommittedCount={2}
      />
    </Frame>
  )
})

export const headMovedPastReview = defineFixture({
  width: 300,
  render: () => (
    <Frame>
      <SourceControlMergedReviewNotice
        review={review}
        worktree={worktree}
        statusHeadOid="e4f5a6b"
        uncommittedCount={0}
      />
    </Frame>
  )
})
