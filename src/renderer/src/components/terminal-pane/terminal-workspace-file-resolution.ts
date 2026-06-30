import { joinAbsolutePath } from '@/lib/terminal-path-normalization'

type WorkspaceBasenameResolutionEntry = { fetchedAt: number; relativePath: string | null }

type ResolveUniqueWorkspaceFile = (args: {
  rootPath: string
  basename: string
  connectionId?: string
}) => Promise<string | null>

// Why: the link provider runs per hovered line; cache the tiny basename answer
// briefly instead of re-running a local/SSH filesystem scan on every lookup.
const WORKSPACE_BASENAME_RESOLUTION_TTL_MS = 15_000
const workspaceBasenameResolutionCache = new Map<string, WorkspaceBasenameResolutionEntry>()

export type ResolveWorkspaceFileArgs = {
  basename: string
  worktreePath: string
  connectionId?: string | null
  /** Test seams. */
  now?: number
  resolveUniqueFileByBasename?: ResolveUniqueWorkspaceFile
}

/**
 * Resolve a bare filename to a file nested elsewhere in the worktree.
 *
 * Why (issue #5024): agent output frequently references a repo file by bare
 * name (e.g. `TerminalContextMenu.test.tsx`), which does not exist at the
 * terminal's cwd root, so the link provider's cwd-relative existence check
 * misses it. Falling back to the worktree's basename resolver makes those
 * mentions clickable. Only a UNIQUE basename match is returned — multiple
 * files sharing a name are ambiguous and left unlinked rather than guessed.
 */
export async function resolveWorkspaceFileByBasename(
  args: ResolveWorkspaceFileArgs
): Promise<string | null> {
  const { basename, worktreePath } = args
  if (!basename || !worktreePath) {
    return null
  }
  const connectionId = args.connectionId ?? undefined
  const now = args.now ?? Date.now()
  const cacheKey = `${connectionId ?? 'local'}::${worktreePath}::${basename}`

  let entry = workspaceBasenameResolutionCache.get(cacheKey)
  if (!entry || now - entry.fetchedAt > WORKSPACE_BASENAME_RESOLUTION_TTL_MS) {
    const resolveUnique =
      args.resolveUniqueFileByBasename ??
      ((lookupArgs) => window.api.fs.resolveUniqueFileByBasename(lookupArgs))
    let relativePath: string | null
    try {
      relativePath = await resolveUnique({
        rootPath: worktreePath,
        basename,
        ...(connectionId ? { connectionId } : {})
      })
    } catch {
      // Best-effort: a failed lookup must not break link detection.
      return null
    }
    entry = { fetchedAt: now, relativePath }
    workspaceBasenameResolutionCache.set(cacheKey, entry)
  }

  if (!entry.relativePath) {
    return null
  }
  return joinAbsolutePath(worktreePath, entry.relativePath)
}

export function __resetWorkspaceFileIndexCacheForTest(): void {
  workspaceBasenameResolutionCache.clear()
}
