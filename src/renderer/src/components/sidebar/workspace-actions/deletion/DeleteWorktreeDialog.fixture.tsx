import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import type { WorktreeAtRiskLocalFiles } from '../../../../../../shared/worktree/removal/at-risk-local-files'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { WorktreeDeleteState } from '@/store/slices/worktrees/teardown/worktree-delete-state-types'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
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

const shortWorktree: Worktree = {
  ...worktree,
  id: 'orca-plugins::/Users/me/orca/workspaces/orca-plugins/fix-login',
  path: '/Users/me/orca/workspaces/orca-plugins/fix-login',
  displayName: 'fix-login',
  branch: 'fix-login'
}

const thirdWorktree: Worktree = {
  ...worktree,
  id: 'orca-plugins::/Users/me/orca/workspaces/orca-plugins/docs-refresh',
  path: '/Users/me/orca/workspaces/orca-plugins/docs-refresh',
  displayName: 'docs-refresh',
  branch: 'docs-refresh'
}

function unsavedFile(worktreeId: string, name: string): OpenFile {
  return {
    id: `${worktreeId}::${name}`,
    filePath: `/Users/me/orca/workspaces/orca-plugins/fix-login/${name}`,
    relativePath: name,
    worktreeId,
    language: 'typescript',
    isDirty: true,
    mode: 'edit'
  }
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

let defaultGitStatus: typeof window.api.git.status | undefined

function dialogFixture(
  options: {
    target?: Worktree
    entries?: GitStatusEntry[]
    batch?: boolean
    unsaved?: boolean
    incomplete?: boolean
    /** Git status resolves with readError, as a worktree folder removed outside Orca does. */
    statusReadFailed?: boolean
    statusPending?: boolean
    ignored?: boolean
    localFiles?: WorktreeAtRiskLocalFiles | 'pending' | 'unsupported'
    heightClassName?: string
    deleteState?: WorktreeDeleteState
  } = {},
  interact?: (frame: HTMLElement) => void
) {
  const target = options.target ?? worktree
  const entries = options.entries ?? dirtyEntries
  const all = options.batch ? [target, shortWorktree, thirdWorktree] : [target]
  const unchecked = options.incomplete || options.statusReadFailed || options.statusPending
  return defineFixture({
    width: 640,
    store: {
      repos: [repo],
      worktreesByRepo: { [repo.id]: all },
      gitStatusByWorktree: unchecked
        ? {}
        : Object.fromEntries(all.map((item) => [item.id, entries])),
      openFiles: options.unsaved
        ? [unsavedFile(target.id, 'src/login.ts'), unsavedFile(target.id, 'src/session.ts')]
        : [],
      deleteStateByWorktreeId: options.deleteState ? { [target.id]: options.deleteState } : {},
      activeModal: 'delete-worktree',
      modalData: options.batch
        ? { worktreeIds: all.map((item) => item.id) }
        : { worktreeId: target.id }
    },
    setup: () => {
      defaultGitStatus ??= window.api.git.status
      window.api.git.status = options.incomplete
        ? async () => {
            throw new Error('Fixture: Git scan unavailable')
          }
        : options.statusPending
          ? () => new Promise<never>(() => {})
          : options.statusReadFailed
            ? async () => ({
                entries: [],
                conflictOperation: 'unknown',
                readError: 'fatal: not a git repository'
              })
            : defaultGitStatus
      window.api.git.atRiskLocalFiles = () => {
        if (options.localFiles === 'pending') {
          return new Promise(() => {})
        }
        if (options.localFiles === 'unsupported') {
          return Promise.reject(
            new RuntimeRpcCallError({
              id: 'fixture',
              ok: false,
              error: { code: 'method_not_found', message: 'Fixture: older runtime' }
            })
          )
        }
        return Promise.resolve(
          options.localFiles ?? {
            count: options.ignored ? 2 : 0,
            samplePaths: options.ignored ? ['.env', 'node_modules/'] : [],
            complete: !unchecked
          }
        )
      }
    },
    // The dialog portals to <body>; reserve room so the centered modal fits the frame.
    render: () => (
      <div className={`${options.heightClassName ?? 'h-[440px]'} bg-background`}>
        <DeleteWorktreeDialog />
      </div>
    ),
    interact
  })
}

export const dirty = dialogFixture({ target: shortWorktree })

export const clean = dialogFixture({ target: shortWorktree, entries: [] })

export const statusReadFailed = dialogFixture({ target: shortWorktree, statusReadFailed: true })

export const dirtyWithUnsavedFiles = dialogFixture({ target: shortWorktree, unsaved: true })

export const dirtyWithIgnoredFiles = dialogFixture({
  target: shortWorktree,
  unsaved: true,
  ignored: true
})

export const cleanWithIgnoredFiles = dialogFixture({
  target: shortWorktree,
  entries: [],
  ignored: true
})

export const showChangesOpen = dialogFixture({ target: shortWorktree, unsaved: true }, () => {
  document.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click()
})

export const longName = dialogFixture()

export const batch = dialogFixture({ target: shortWorktree, batch: true })

export const batchUnsavedIncomplete = dialogFixture({
  target: shortWorktree,
  batch: true,
  entries: [],
  unsaved: true,
  incomplete: true
})

export const batchUncommittedIgnored = dialogFixture({
  target: shortWorktree,
  batch: true,
  ignored: true
})

export const batchAllLosses = dialogFixture({
  target: shortWorktree,
  batch: true,
  unsaved: true,
  ignored: true
})

export const batchCleanIncomplete = dialogFixture({
  target: shortWorktree,
  batch: true,
  entries: [],
  incomplete: true
})

export const forceDelete = dialogFixture({
  target: shortWorktree,
  deleteState: {
    isDeleting: false,
    error:
      "fatal: '/Users/me/orca/workspaces/orca-plugins/fix-login' contains modified or untracked files, use --force to delete it",
    canForceDelete: true,
    forceDeleteReason: 'dirty'
  }
})

export const checking = dialogFixture({
  target: shortWorktree,
  statusPending: true,
  localFiles: 'pending'
})
export const cleanIgnoredChecking = dialogFixture({ entries: [], localFiles: 'pending' })
export const ignoredFilesUnchecked = dialogFixture({ entries: [], localFiles: 'unsupported' })
export const ignoredFiles = dialogFixture({ entries: [], localFiles: atRiskLocalFiles })
export const ignoredFilesOpen = dialogFixture({ entries: [], localFiles: atRiskLocalFiles }, () => {
  document.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click()
})
export const ignoredFilesScrolling = dialogFixture(
  { entries: [], localFiles: manyAtRiskLocalFiles, heightClassName: 'h-[580px]' },
  () => {
    document.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click()
  }
)
export const dirtyAndIgnoredOpen = dialogFixture(
  {
    target: shortWorktree,
    entries: dirtyEntries,
    unsaved: true,
    localFiles: manyAtRiskLocalFiles,
    heightClassName: 'h-[580px]'
  },
  () => {
    document.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click()
  }
)
export const alwaysDeleteMenu = dialogFixture(
  { entries: dirtyEntries, localFiles: cleanLocalFiles },
  () => {
    document.querySelector<HTMLButtonElement>('[role="checkbox"]')?.click()
  }
)
