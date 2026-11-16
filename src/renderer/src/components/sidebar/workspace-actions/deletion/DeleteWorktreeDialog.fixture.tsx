import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import type { WorktreeAtRiskLocalFiles } from '../../../../../../shared/worktree/removal/at-risk-local-files'
import DeleteWorktreeDialog from './DeleteWorktreeDialog'

const repo: Repo = {
  id: 'orca-plugins',
  path: '/Users/me/orca/orca-plugins',
  displayName: 'orca-plugins',
  badgeColor: '',
  addedAt: 1
}

const worktree: Worktree = {
  id: 'orca-plugins::/Users/me/orca/workspaces/orca-plugins/support-editable-excalidraw',
  repoId: repo.id,
  path: '/Users/me/orca/workspaces/orca-plugins/support-editable-excalidraw',
  displayName: 'Support editable .excalidraw.svg and .excalidraw.png files',
  branch: 'support-editable-excalidraw',
  head: 'abc123',
  isBare: false,
  isMainWorktree: false,
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1
}

const dirtyEntries: GitStatusEntry[] = Array.from({ length: 13 }, (_, index) => ({
  path: `src/excalidraw/file-${index}.ts`,
  status: index % 3 === 0 ? 'untracked' : 'modified',
  area: index % 3 === 0 ? 'untracked' : 'unstaged'
}))

const cleanLocalFiles: WorktreeAtRiskLocalFiles = {
  count: 0,
  samplePaths: [],
  paths: [],
  complete: true
}

const atRiskLocalFiles: WorktreeAtRiskLocalFiles = {
  count: 5,
  samplePaths: ['.anti-slop-plugin/', '.tmp/', 'tests/e2e/.cross-version-checkouts/'],
  paths: [
    '.anti-slop-plugin/',
    '.tmp/',
    'tests/e2e/.cross-version-checkouts/',
    '.env.local',
    'scratch/migration-dump.sql'
  ],
  complete: true
}

const manyAtRiskLocalFiles: WorktreeAtRiskLocalFiles = {
  count: 14,
  samplePaths: ['.env.local', '.anti-slop-plugin/', '.tmp/'],
  paths: [
    '.env.local',
    '.env.development.local',
    '.anti-slop-plugin/',
    '.tmp/',
    'local/',
    'scratch/migration-dump.sql',
    'scratch/perf-trace.json',
    'tests/e2e/.cross-version-checkouts/',
    'tests/fixtures/.local-snapshots/',
    'packages/desktop/.orca-local/session-override.json',
    'packages/cli/.local-config.yaml',
    'scripts/private/bench-results.csv',
    'docs/drafts/notes.md',
    'tools/sandbox/state.db'
  ],
  complete: true
}

function dialogFixture(options: {
  entries: GitStatusEntry[]
  localFiles?: WorktreeAtRiskLocalFiles | 'pending'
  heightClassName?: string
  interact?: (frame: HTMLElement) => void
}) {
  return defineFixture({
    width: 640,
    store: {
      repos: [repo],
      worktreesByRepo: { [repo.id]: [worktree] },
      gitStatusByWorktree: { [worktree.id]: options.entries },
      activeModal: 'delete-worktree',
      modalData: { worktreeId: worktree.id }
    },
    setup: () => {
      const localFiles = options.localFiles ?? cleanLocalFiles
      window.api.git.atRiskLocalFiles = () =>
        localFiles === 'pending' ? new Promise(() => {}) : Promise.resolve(localFiles)
    },
    // The dialog portals to <body>; reserve room so the centered modal fits the frame.
    render: () => (
      <div className={`${options.heightClassName ?? 'h-[440px]'} bg-background`}>
        <DeleteWorktreeDialog />
      </div>
    ),
    interact: options.interact
  })
}

export const checking = dialogFixture({ entries: [], localFiles: 'pending' })

export const clean = dialogFixture({ entries: [], localFiles: cleanLocalFiles })

export const ignoredFiles = dialogFixture({ entries: [], localFiles: atRiskLocalFiles })

export const ignoredFilesOpen = dialogFixture({
  entries: [],
  localFiles: atRiskLocalFiles,
  heightClassName: 'h-[540px]',
  interact: () => {
    document.querySelector<HTMLButtonElement>('[aria-label*="Show ignored paths"]')?.click()
  }
})

export const ignoredFilesScrolling = dialogFixture({
  entries: [],
  localFiles: manyAtRiskLocalFiles,
  heightClassName: 'h-[580px]',
  interact: () => {
    document.querySelector<HTMLButtonElement>('[aria-label*="Show ignored paths"]')?.click()
  }
})

export const dirty = dialogFixture({ entries: dirtyEntries, localFiles: atRiskLocalFiles })

export const alwaysDeleteMenu = dialogFixture({
  entries: dirtyEntries,
  localFiles: cleanLocalFiles,
  interact: () => {
    document
      .querySelector<HTMLButtonElement>('[aria-label="More delete options"]')
      ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  }
})
