import { useLayoutEffect, useRef, useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { ConfirmationDialogProvider } from '../../dismiss/confirmation/confirmation-dialog'
import PullRequestPage from './surface'
import type { GitHubWorkItem } from '../../../../../shared/github/work-items/work-item-types'

// Synthetic data only: invented repo, author and link.
const item: GitHubWorkItem = {
  id: 'fixture-pr-12',
  type: 'pr',
  number: 12,
  title: 'Keep the panel steady while it loads',
  state: 'open',
  url: 'https://github.com/sample-org/sample-repo/pull/12',
  labels: [],
  updatedAt: '2026-01-05T09:00:00Z',
  author: 'sample-author',
  repoId: 'fixture-repo'
}

// Why: every GitHub read stays pending, so the page is an uncached PR whose details never arrive.
function holdGitHubReads(): void {
  const gh = window.api.gh
  Reflect.set(
    window.api,
    'gh',
    new Proxy(gh, {
      get: (target, key) =>
        typeof key === 'string' && !/^on[A-Z]/.test(key)
          ? () => new Promise(() => {})
          : Reflect.get(target, key)
    })
  )
}

/** Freezes the first committed DOM (before any passive effect runs) so the first frame can be captured. */
function FirstCommit({ children }: { children: React.ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [html, setHtml] = useState<string | null>(null)
  useLayoutEffect(() => {
    setHtml((current) => current ?? ref.current?.innerHTML ?? '')
  }, [])
  return html === null ? (
    <div ref={ref}>{children}</div>
  ) : (
    // oxlint-disable-next-line react/no-danger -- SAFETY: fixture-only replay of markup this component just rendered.
    <div dangerouslySetInnerHTML={{ __html: html }} />
  )
}

function Page({ repoPath }: { repoPath: string | null }): React.JSX.Element {
  return (
    <ConfirmationDialogProvider>
      <div className="h-[640px] bg-background text-foreground">
        <PullRequestPage
          workItem={item}
          repoPath={repoPath}
          repoId="fixture-repo"
          onUse={() => {}}
          onClose={() => {}}
        />
      </div>
    </ConfirmationDialogProvider>
  )
}

// Why: 560 px is the PR page's content width at the window's 600 px minimum.
export const firstCommit = defineFixture({
  width: 560,
  setup: holdGitHubReads,
  render: () => (
    <FirstCommit>
      <Page repoPath="/fixture/sample-repo" />
    </FirstCommit>
  )
})
export const settledPending = defineFixture({
  width: 560,
  setup: holdGitHubReads,
  render: () => <Page repoPath="/fixture/sample-repo" />
})
export const noReadRoute = defineFixture({
  width: 560,
  setup: holdGitHubReads,
  render: () => <Page repoPath={null} />
})
