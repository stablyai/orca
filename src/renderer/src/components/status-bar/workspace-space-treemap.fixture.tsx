import { defineFixture } from '../../component-fixtures/component-fixture'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type {
  WorkspaceSpaceItem,
  WorkspaceSpaceWorktree
} from '../../../../shared/workspace-space-types'
import { WorkspaceSpaceTreemap } from './workspace-space-treemap'
import { WorkspaceSpaceBreakdownList } from './workspace-space-breakdown-list'
import { getWorkspaceSpaceWorktreeIdentity } from './workspace-space-delete-selection'

const GB = 1024 ** 3
const MB = 1024 ** 2
const SCANNED_AT = Date.UTC(2026, 10, 5, 9, 30)
const REPO_PATH = '/Users/dev/code/orca'

const TOP_LEVEL_NAMES = [
  'node_modules',
  '.git',
  'out',
  'dist',
  '.cache',
  'src',
  'resources',
  'docs',
  'config',
  'tests',
  'native',
  'packages',
  'build',
  'scripts',
  '.github',
  'e2e',
  'mobile',
  'web',
  'cli',
  'fixtures',
  'patches',
  'public',
  'assets',
  'skills',
  'locales',
  '.vscode',
  '.husky',
  'coverage',
  'tmp',
  'vendor',
  'pnpm-lock.yaml',
  'package.json',
  'tsconfig.json',
  'README.md',
  'AGENTS.md',
  'CHANGELOG.md',
  'LICENSE',
  'mise.toml',
  '.gitignore',
  '.oxlintrc.json'
]

function topLevelItems(worktreePath: string, sizeBytes: number): WorkspaceSpaceItem[] {
  const weights = TOP_LEVEL_NAMES.map((_, index) => 1 / (index + 1) ** 1.6)
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  return TOP_LEVEL_NAMES.map((name, index) => ({
    name,
    path: `${worktreePath}/${name}`,
    kind: name.includes('.') && !name.startsWith('.') ? 'file' : 'directory',
    sizeBytes: Math.round((sizeBytes * weights[index]) / totalWeight)
  }))
}

function worktree(
  slug: string,
  sizeBytes: number,
  options: { isMainWorktree?: boolean; items?: boolean } = {}
): WorkspaceSpaceWorktree {
  const path = options.isMainWorktree ? REPO_PATH : `/Users/dev/orca/workspaces/orca/${slug}`
  return {
    worktreeId: `repo-orca::${path}`,
    repoId: 'repo-orca',
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    repoDisplayName: 'orca',
    repoPath: REPO_PATH,
    displayName: slug,
    path,
    branch: options.isMainWorktree ? 'main' : `dev/${slug}`,
    isMainWorktree: options.isMainWorktree ?? false,
    isRemote: false,
    isSparse: false,
    canDelete: !options.isMainWorktree,
    lastActivityAt: SCANNED_AT - sizeBytes / 1000,
    status: 'ok',
    error: null,
    scannedAt: SCANNED_AT,
    sizeBytes,
    reclaimableBytes: options.isMainWorktree ? 0 : sizeBytes,
    skippedEntryCount: 0,
    topLevelItems: options.items ? topLevelItems(path, sizeBytes) : [],
    omittedTopLevelItemCount: 0,
    omittedTopLevelSizeBytes: 0
  }
}

const ROWS: WorkspaceSpaceWorktree[] = [
  worktree('orca', 9.8 * GB, { isMainWorktree: true, items: true }),
  worktree('fix-clippingissue', 8.27 * GB),
  worktree('terminal-reflow', 7.22 * GB),
  worktree('mobile-pairing', 6.96 * GB),
  worktree('ssh-relay-auth', 4.01 * GB),
  worktree('docs-refresh', 184 * MB),
  worktree('i18n-sweep', 152 * MB),
  worktree('usage-bars', 121 * MB),
  worktree('tab-groups', 96 * MB),
  worktree('pet-status', 64 * MB),
  worktree('ci-planner', 38 * MB),
  worktree('notes-scratch', 12 * MB)
]
const SELECTED = ROWS[0]
const SELECTED_ID = getWorkspaceSpaceWorktreeIdentity(SELECTED)

function overviewGrid({
  width,
  zoomed = false,
  scanning = false,
  selected = true
}: {
  width: number
  zoomed?: boolean
  scanning?: boolean
  selected?: boolean
}) {
  return defineFixture({
    width,
    render: () => (
      <div className="bg-background p-3">
        <div className="grid min-h-0 grid-cols-[minmax(0,1.4fr)_minmax(16rem,0.6fr)] gap-2.5">
          <WorkspaceSpaceTreemap
            rows={scanning ? [] : ROWS}
            isScanning={scanning}
            selectedWorktreeId={scanning || !selected ? null : SELECTED_ID}
            zoomedWorktree={zoomed ? SELECTED : null}
            onSelect={() => {}}
            onZoomChange={() => {}}
          />
          <WorkspaceSpaceBreakdownList
            worktree={scanning || !selected ? null : SELECTED}
            isScanning={scanning}
          />
        </div>
      </div>
    )
  })
}

export const overview = overviewGrid({ width: 1056 })
export const narrow = overviewGrid({ width: 700 })
export const zoomed = overviewGrid({ width: 1056, zoomed: true })
export const scanning = overviewGrid({ width: 1056, scanning: true })
export const narrowZoomed = overviewGrid({ width: 700, zoomed: true })
export const narrowScanning = overviewGrid({ width: 700, scanning: true })
export const noSelection = overviewGrid({ width: 1056, selected: false })
