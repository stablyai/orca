import type { HttpLinkDestination } from '@/lib/http-link-destinations'

export type FileOpenFailure = {
  /** `missing` is a verified absence; `unverifiable` means the host could not answer (dropped SSH, timeout, denied path). */
  verdict: 'missing' | 'unverifiable'
  error: unknown
}

export type TerminalFileOpenDeps = {
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId?: string | null
  wslDistro?: string | null
  /** Shift+modifier: the OS default app, or the other link-routing browser for a local HTML file. */
  openWithSystemDefault?: boolean
  /** Where a local HTML file opens, chosen from its popover; otherwise link routing decides. */
  browserDestination?: HttpLinkDestination
  /** The paired-server terminal that printed the link; lets its host grant a file outside workspaces. */
  terminalHandle?: string | null
  hostFileOnly?: boolean
  /** Reports a path that could not be verified before opening; skipped once a later open supersedes it. */
  onOpenFailure?: (failure: FileOpenFailure) => void
  /** The tab that owns the link; editor opens place themselves relative to its group. */
  sourceTabId?: string | null
  /** "Open in this group": pins the source tab's group at activation, or refuses. */
  openInSourceGroup?: boolean
  /** Opt-in menu request; the legacy flag remains editor-only. */
  openInSourceGroupSurface?: 'internal' | 'browser'
}
