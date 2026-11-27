import { defineFixture } from '../../../component-fixtures/component-fixture'
import { ConfirmationDialogProvider } from '../../dismiss/confirmation/confirmation-dialog'
import { ChecksTab } from './tab'
import type { GitHubWorkItem } from '../../../../../shared/github/work-items/work-item-types'
import type { PRCheckDetail } from '../../../../../shared/github/checks/check-types'

// Synthetic data only: invented repo, author, check names and links.
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
  authorAvatarUrl: 'data:,',
  repoId: 'fixture-repo'
}

const checks: PRCheckDetail[] = [
  { name: 'lint', status: 'completed', conclusion: 'success', url: 'https://example.com/1' },
  { name: 'unit tests', status: 'completed', conclusion: 'success', url: 'https://example.com/2' },
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

function Checks({
  loaded = false,
  variant
}: {
  loaded?: boolean
  variant: 'compact' | 'page'
}): React.JSX.Element {
  const tab = (
    <ChecksTab
      item={item}
      repoPath="/fixture/sample-repo"
      repoId="fixture-repo"
      headSha="0000000000000000000000000000000000000002"
      checks={loaded ? checks : []}
      loading={!loaded}
      variant={variant}
      onChecksUpdated={() => {}}
    />
  )
  return (
    <ConfirmationDialogProvider>
      <div className="bg-background p-4 text-foreground">
        {variant === 'compact' ? (
          // Why: same card the PR page's Conversation sidebar wraps the compact Checks tab in.
          <aside className="overflow-hidden rounded-lg border border-border/50 bg-card shadow-xs">
            {tab}
          </aside>
        ) : (
          tab
        )}
      </div>
    </ConfirmationDialogProvider>
  )
}

// Why: 560 px is the PR page's content width at the window's 600 px minimum; the sidebar card is 300 px.
export const pageCold = defineFixture({ width: 560, render: () => <Checks variant="page" /> })
export const pageLoaded = defineFixture({
  width: 560,
  render: () => <Checks variant="page" loaded />
})
export const sidebarCold = defineFixture({ width: 332, render: () => <Checks variant="compact" /> })
export const sidebarLoaded = defineFixture({
  width: 332,
  render: () => <Checks variant="compact" loaded />
})
