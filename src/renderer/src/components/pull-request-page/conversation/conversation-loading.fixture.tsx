import { defineFixture } from '../../../component-fixtures/component-fixture'
import { ConfirmationDialogProvider } from '../../dismiss/confirmation/confirmation-dialog'
import { ConversationTab } from './tab'
import type { GitHubWorkItem } from '../../../../../shared/github/work-items/work-item-types'
import type { PRComment } from '../../../../../shared/github/comments/comment-types'

// Synthetic data only: invented repo, authors, paths and links.
// Why: an empty avatar URL falls back to github.com/<login>.png, which can fetch a real account's picture;
// a blank data URL fails locally so the card shows initials.
const noAvatar = 'data:,'
const item: GitHubWorkItem = {
  id: 'fixture-pr-12',
  type: 'pr',
  number: 12,
  title: 'Keep the panel steady while it loads',
  state: 'open',
  url: 'https://example.com/sample-org/sample-repo/pull/12',
  labels: [],
  updatedAt: '2026-01-05T09:00:00Z',
  author: 'sample-author',
  repoId: 'fixture-repo'
}

const body =
  'Shows placeholder rows while the details read runs, so the page does not jump when they land.'

const comments: PRComment[] = [
  {
    id: 1,
    author: 'sample-dev',
    authorAvatarUrl: noAvatar,
    body: 'Could this read the cached value first? The panel flickers on every switch.',
    createdAt: '2026-01-05T10:00:00Z',
    url: 'https://example.com/c1'
  },
  {
    id: 2,
    author: 'sample-reviewer',
    authorAvatarUrl: noAvatar,
    body: 'Looks good once the empty state keeps its copy.',
    createdAt: '2026-01-05T11:00:00Z',
    url: 'https://example.com/c2'
  }
]

function Conversation({ loaded = false }: { loaded?: boolean }): React.JSX.Element {
  return (
    <ConfirmationDialogProvider>
      <div className="bg-background text-foreground">
        <ConversationTab
          item={item}
          repoPath="/fixture/sample-repo"
          repoId="fixture-repo"
          body={loaded ? body : ''}
          comments={loaded ? comments : []}
          files={[]}
          headSha={undefined}
          baseSha={undefined}
          loading={!loaded}
          detailsLoaded={loaded}
          checks={[]}
          participants={[]}
          localState="open"
          onStateChange={() => {}}
          projectOrigin={undefined}
          onMutated={() => {}}
          onChecksUpdated={() => {}}
          onBodyUpdated={() => {}}
          onCommentAdded={() => {}}
          onReviewersRequested={() => {}}
        />
      </div>
    </ConfirmationDialogProvider>
  )
}

// Why: 560 px is the PR page's content width at the window's 600 px minimum.
export const coldNarrow = defineFixture({
  width: 560,
  render: () => <Conversation />
})
export const loadedNarrow = defineFixture({
  width: 560,
  render: () => <Conversation loaded />
})
export const coldWide = defineFixture({
  width: 960,
  render: () => <Conversation />
})
export const loadedWide = defineFixture({
  width: 960,
  render: () => <Conversation loaded />
})
