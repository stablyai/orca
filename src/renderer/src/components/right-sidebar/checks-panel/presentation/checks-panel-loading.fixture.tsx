import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { ChecksList } from './checks-list'
import { PRCommentsList } from '../comments/comments-list'
import { ChecksPanelLoadingAnnouncement } from './checks-panel-loading-announcement'
import type { PRCheckDetail } from '../../../../../../shared/github/checks/check-types'
import type { PRComment } from '../../../../../../shared/github/comments/comment-types'

// Synthetic data only: invented check names, authors and paths.
const checks: PRCheckDetail[] = [
  { name: 'lint', status: 'completed', conclusion: 'success', url: 'https://example.com/1' },
  {
    name: 'unit tests',
    status: 'in_progress',
    conclusion: 'pending',
    url: 'https://example.com/2'
  },
  { name: 'typecheck', status: 'completed', conclusion: 'success', url: 'https://example.com/3' },
  {
    name: 'build (linux)',
    status: 'completed',
    conclusion: 'success',
    url: 'https://example.com/4'
  },
  {
    name: 'build (macos)',
    status: 'completed',
    conclusion: 'success',
    url: 'https://example.com/5'
  }
]

const comments: PRComment[] = [
  {
    id: 1,
    author: 'river-dev',
    authorAvatarUrl: '',
    body: 'Could this read the cached value first? The panel flickers on every switch.',
    createdAt: '2026-01-05T10:00:00Z',
    url: 'https://example.com/c1',
    path: 'src/panel/list.tsx',
    line: 42,
    threadId: 't1',
    isResolved: false
  },
  {
    id: 2,
    author: 'sample-reviewer',
    authorAvatarUrl: '',
    body: 'Looks good once the empty state keeps its copy.',
    createdAt: '2026-01-05T11:00:00Z',
    url: 'https://example.com/c2'
  }
]

function Panel({
  loaded = false,
  refreshing = false,
  emptyRefreshing = false,
  failed = false
}: {
  loaded?: boolean
  refreshing?: boolean
  emptyRefreshing?: boolean
  failed?: boolean
}): React.JSX.Element {
  const showData = loaded || refreshing
  const coldLoading = !showData && !failed && !emptyRefreshing
  return (
    <div className="h-[560px] overflow-auto bg-sidebar text-foreground scrollbar-sleek">
      <ChecksPanelLoadingAnnouncement loading={coldLoading} reviewKey="fixture" />
      <ChecksList
        checks={showData ? checks : []}
        checksError={failed ? 'Couldn’t read checks. Check your connection and try again.' : null}
        checksLoading={!loaded && !failed}
        loadingSkeleton={coldLoading}
        checkDetailsContextKey="fixture"
        worktreeId="fixture-worktree"
      />
      <PRCommentsList
        comments={showData ? comments : []}
        commentsError={failed ? 'Couldn’t read comments.' : null}
        commentsLoading={!loaded && !failed}
        loadingSkeleton={coldLoading}
        onAddComment={async () => ({ ok: true })}
      />
    </div>
  )
}

export const coldNarrow = defineFixture({ width: 280, render: () => <Panel /> })
export const coldWide = defineFixture({ width: 420, render: () => <Panel /> })
export const loadedNarrow = defineFixture({ width: 280, render: () => <Panel loaded /> })
export const loadedWide = defineFixture({ width: 420, render: () => <Panel loaded /> })
export const refreshing = defineFixture({ width: 420, render: () => <Panel refreshing /> })
export const emptyRefreshing = defineFixture({
  width: 420,
  render: () => <Panel emptyRefreshing />
})
export const failed = defineFixture({ width: 420, render: () => <Panel failed /> })
