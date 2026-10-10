import {
  SIBLING_WORKTREES_DIR_SUFFIX,
  type WorktreeLayout
} from '../../../../shared/worktree-layout'

const EXAMPLE_REPO_FOLDER = 'my-repo'
const EXAMPLE_WORKTREE_FOLDER = 'feature'

/** Short example of where a new worktree lands, built from the configured workspace directory. */
export function buildWorktreeLayoutExamplePath(
  layout: WorktreeLayout,
  workspaceDir: string
): string {
  const trimmed = workspaceDir.trim()
  const separator = trimmed.includes('\\') && !trimmed.includes('/') ? '\\' : '/'
  const join = (...segments: string[]): string => segments.join(separator)
  if (layout === 'sibling') {
    return join(
      '…',
      `${EXAMPLE_REPO_FOLDER}${SIBLING_WORKTREES_DIR_SUFFIX}`,
      EXAMPLE_WORKTREE_FOLDER
    )
  }
  const root = shortenWorkspaceRoot(trimmed, separator)
  return layout === 'nested'
    ? join(root, EXAMPLE_REPO_FOLDER, EXAMPLE_WORKTREE_FOLDER)
    : join(root, EXAMPLE_WORKTREE_FOLDER)
}

// Why keep only the tail: the example should read at a glance, not repeat a long home path.
function shortenWorkspaceRoot(workspaceDir: string, separator: string): string {
  const segments = workspaceDir.split(/[\\/]+/).filter(Boolean)
  if (segments.length === 0) {
    return '…'
  }
  if (segments.length <= 2) {
    return workspaceDir.replace(/[\\/]+$/, '')
  }
  return ['…', ...segments.slice(-2)].join(separator)
}
