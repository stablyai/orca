import type { PtyManagementGeneration, PtyManagementSession } from '../../../../preload/api-types'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'

export function shortCwd(cwd: string): string {
  if (!cwd) {
    return 'unknown'
  }
  const separator = cwd.includes('\\') ? '\\' : '/'
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts.length > 2 ? parts.slice(-2).join(separator) : cwd
}

export function formatWorkspace(session: { cwd: string | null; sessionId: string }): string {
  if (session.cwd) {
    return shortCwd(session.cwd)
  }
  const sep = session.sessionId.lastIndexOf('@@')
  if (sep !== -1) {
    const worktreeId = session.sessionId.slice(0, sep)
    return shortCwd(splitWorktreeIdForFilesystem(worktreeId)?.worktreePath ?? worktreeId)
  }
  return 'unknown'
}

// The daemon drops every non-alive session before it leaves the host
// (listLiveTerminalHostSessions), so `isAlive` cannot answer for one that never arrived. Only the
// host-reported `state` may say 'exited'.
export function formatState(session: PtyManagementSession): string {
  if (session.shellState === 'ready') {
    return 'running'
  }
  if (session.shellState === 'pending') {
    return 'starting'
  }
  return session.state
}

/**
 * A generation's session count, or null when it could not be counted: a count we could not take
 * is not a count of zero (docs/reference/ssh-execution-boundary.md). The caller words the null.
 */
export function generationSessionCount(generation: PtyManagementGeneration): number | null {
  if (generation.contact === 'unverifiable') {
    return null
  }
  return generation.contact === 'live' ? generation.sessions.length : 0
}

/** The current version always; a previous one only while it has sessions or could not answer. */
export function visibleGenerations(
  generations: PtyManagementGeneration[]
): PtyManagementGeneration[] {
  return generations.filter(
    (generation) =>
      generation.isCurrent ||
      generation.contact === 'unverifiable' ||
      (generation.contact === 'live' && generation.sessions.length > 0)
  )
}

/** The total, marked as a lower bound while a generation could not be counted; null when nothing was. */
export function formatVisibleSessionCount(generations: PtyManagementGeneration[]): string | null {
  const counted = generations.reduce(
    (total, generation) => total + (generation.contact === 'live' ? generation.sessions.length : 0),
    0
  )
  if (!generations.some((generation) => generation.contact === 'unverifiable')) {
    return String(counted)
  }
  return counted > 0 ? `${counted}+` : null
}

/** Flattens only what a generation actually reported; unreachable generations contribute nothing. */
export function reportedSessions(generations: PtyManagementGeneration[]): PtyManagementSession[] {
  return generations.flatMap((generation) =>
    generation.contact === 'live' ? generation.sessions : []
  )
}
