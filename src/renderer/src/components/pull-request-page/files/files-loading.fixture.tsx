import { defineFixture } from '../../../component-fixtures/component-fixture'
import { PRFilesCombinedDiffViewer } from './combined-diff-viewer'
import { PRFilesLoading } from './files-loading'
import type { GitHubPRFile } from '../../../../../shared/github/pull-requests/pull-request-types'

// Synthetic data only: invented paths, repo and links. File contents stay pending, so sections show their own loading body.
const files: GitHubPRFile[] = [
  { path: 'src/panel/list.tsx', status: 'modified', additions: 12, deletions: 4, isBinary: false },
  { path: 'src/panel/row.tsx', status: 'modified', additions: 3, deletions: 1, isBinary: false },
  { path: 'docs/notes.md', status: 'added', additions: 8, deletions: 0, isBinary: false }
]

function pendingContents(): void {
  Reflect.set(window.api, 'gh', { ...window.api.gh, prFileContents: () => new Promise(() => {}) })
}

function Files({ loaded = false }: { loaded?: boolean }): React.JSX.Element {
  return (
    <div className="flex h-[480px] flex-col bg-background text-foreground">
      {loaded ? (
        <PRFilesCombinedDiffViewer
          files={files}
          comments={[]}
          repoPath="/fixture/sample-repo"
          repoId="fixture-repo"
          prNumber={12}
          prRepo={{ owner: 'sample-org', repo: 'sample-repo' }}
          prUrl="https://example.com/sample-org/sample-repo/pull/12"
          headSha="0000000000000000000000000000000000000002"
          baseSha="0000000000000000000000000000000000000001"
          pendingViewedPaths={new Set()}
          onCommentAdded={() => {}}
          onViewedChange={async () => true}
        />
      ) : (
        <PRFilesLoading />
      )}
    </div>
  )
}

// Why: 560 px is the PR page's content width at the window's 600 px minimum.
export const coldNarrow = defineFixture({ width: 560, render: () => <Files /> })
export const loadedNarrow = defineFixture({
  width: 560,
  setup: pendingContents,
  render: () => <Files loaded />
})
export const coldWide = defineFixture({ width: 1000, render: () => <Files /> })
export const loadedWide = defineFixture({
  width: 1000,
  setup: pendingContents,
  render: () => <Files loaded />
})
