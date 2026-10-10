/**
 * Where new git worktrees go:
 * - `nested`: `<workspace dir>/<repo>/<name>`
 * - `flat`: `<workspace dir>/<name>`
 * - `sibling`: `<repo parent>/<repo>.worktrees/<name>`, beside the repo and outside its working tree
 */
export const WORKTREE_LAYOUTS = ['nested', 'flat', 'sibling'] as const
export type WorktreeLayout = (typeof WORKTREE_LAYOUTS)[number]

export const SIBLING_WORKTREES_DIR_SUFFIX = '.worktrees'

/** `../<repo>.worktrees`: repo-relative, so it resolves on the repo's own host and filesystem. */
export function buildSiblingWorktreesBasePath(repoFolderName: string): string {
  return `../${repoFolderName}${SIBLING_WORKTREES_DIR_SUFFIX}`
}

type WorktreeLayoutSettings = {
  worktreeLayout?: WorktreeLayout | null
  nestWorkspaces: boolean
}

export function isWorktreeLayout(value: unknown): value is WorktreeLayout {
  return typeof value === 'string' && WORKTREE_LAYOUTS.some((layout) => layout === value)
}

/** `worktreeLayout` wins; profiles written before it existed derive nested/flat from the boolean. */
export function resolveWorktreeLayout(settings: WorktreeLayoutSettings): WorktreeLayout {
  if (isWorktreeLayout(settings.worktreeLayout)) {
    return settings.worktreeLayout
  }
  return settings.nestWorkspaces ? 'nested' : 'flat'
}

/** The boolean older builds read. Sibling keeps it, so an older build falls back to the
 *  workspace-directory layout the user last had. */
export function nestWorkspacesForLayout(layout: WorktreeLayout, current: boolean): boolean {
  return layout === 'sibling' ? current : layout === 'nested'
}

/** Settings patch for choosing a layout; carries the legacy boolean so both stay coherent. */
export function buildWorktreeLayoutSettingsUpdate(
  layout: WorktreeLayout,
  current: Pick<WorktreeLayoutSettings, 'nestWorkspaces'>
): { worktreeLayout: WorktreeLayout; nestWorkspaces: boolean } {
  return {
    worktreeLayout: layout,
    nestWorkspaces: nestWorkspacesForLayout(layout, current.nestWorkspaces)
  }
}

/**
 * Normalizes a settings write so `worktreeLayout` and `nestWorkspaces` never disagree. A write of
 * only the boolean that changes it (an older writer) moves the layout to nested/flat instead of
 * being silently overridden by a stored layout. Returns null when neither key is written.
 */
export function normalizeWorktreeLayoutUpdate(
  current: WorktreeLayoutSettings,
  updates: { worktreeLayout?: unknown; nestWorkspaces?: unknown }
): { worktreeLayout?: WorktreeLayout; nestWorkspaces?: boolean } | null {
  if ('worktreeLayout' in updates) {
    if (!isWorktreeLayout(updates.worktreeLayout)) {
      // Why: an unknown or cleared value falls back to deriving from the boolean.
      return { worktreeLayout: undefined }
    }
    const nestWorkspaces =
      typeof updates.nestWorkspaces === 'boolean' ? updates.nestWorkspaces : current.nestWorkspaces
    return buildWorktreeLayoutSettingsUpdate(updates.worktreeLayout, { nestWorkspaces })
  }
  if (
    typeof updates.nestWorkspaces === 'boolean' &&
    updates.nestWorkspaces !== current.nestWorkspaces &&
    isWorktreeLayout(current.worktreeLayout)
  ) {
    return {
      nestWorkspaces: updates.nestWorkspaces,
      worktreeLayout: updates.nestWorkspaces ? 'nested' : 'flat'
    }
  }
  return null
}
