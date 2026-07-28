import { splitWorktreeIdForFilesystem } from './worktree-id'

const DRIVE_ROOTED = /^[a-z]:\//
const CWD_PAYLOAD_KEYS = ['cwd', 'workspaceRoot', 'workspace_root'] as const

/** Session cwd the agent reported in its own hook payload, for sources that expose one. */
export function readHookPayloadCwd(hookPayload: unknown): string | undefined {
  if (typeof hookPayload !== 'object' || hookPayload === null) {
    return undefined
  }
  const record = hookPayload as Record<string, unknown>
  for (const key of CWD_PAYLOAD_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }
  return undefined
}

/** Resolve `.` and `..` lexically so a path can't pose as living under another. */
function collapseDotSegments(absolutePath: string): string {
  const driveRoot = DRIVE_ROOTED.test(absolutePath) ? absolutePath.slice(0, 2) : ''
  const segments: string[] = []
  for (const segment of absolutePath.slice(driveRoot.length).split('/')) {
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment === '..') {
      // Why: `/..` is the root itself, so an over-popping prefix must not escape it.
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  // Why: a collapsed drive root keeps its slash, else `c:` fails DRIVE_ROOTED and a
  // Windows path would be compared against a POSIX one as if the notations matched.
  return segments.length > 0
    ? `${driveRoot}/${segments.join('/')}`
    : driveRoot
      ? `${driveRoot}/`
      : '/'
}

/** Reduce a path to a comparable form, or null when it has no root this can compare. */
function normalizeComparablePath(raw: string): string | null {
  const lowered = raw.trim().replace(/\\/g, '/').toLowerCase()
  // Why: UNC (`//wsl$/…`) and relative paths have no comparable root — unknown, not conflicting.
  if (lowered.startsWith('//') || (!lowered.startsWith('/') && !DRIVE_ROOTED.test(lowered))) {
    return null
  }
  return collapseDotSegments(lowered)
}

/** True when `inner` is `outer` itself or sits beneath it. */
function isSameOrInside(inner: string, outer: string): boolean {
  return inner === outer || inner.startsWith(outer.endsWith('/') ? outer : `${outer}/`)
}

/**
 * True when the worktree a hook claims cannot own the session that sent it, judged
 * against the cwd that session reported in its own payload.
 *
 * Why: paneKey and worktreeId ride in PTY env, and env is inherited. A shared agent
 * daemon pre-warmed from one pane hands its Orca identity to every session it later
 * hosts, so a session in worktree A reports pane B and its status lands on the wrong
 * workspace card. Refuse only when both paths are absolute, written in the same
 * notation, and disjoint; anything unclear stays attributed, since dropping a real
 * status row is the worse failure.
 */
export function hookCwdContradictsWorktree(
  worktreeId: string | undefined,
  cwd: string | undefined
): boolean {
  if (!worktreeId || !cwd) {
    return false
  }
  const worktreePath = splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
  if (!worktreePath) {
    return false
  }
  const workspace = normalizeComparablePath(worktreePath)
  const session = normalizeComparablePath(cwd)
  if (!workspace || !session) {
    return false
  }
  // Why: a WSL session reports /mnt/c/… for a C:\… worktree; mixed notations aren't comparable.
  if (DRIVE_ROOTED.test(workspace) !== DRIVE_ROOTED.test(session)) {
    return false
  }
  // Why: a session started in a subdirectory is normal, and so is a workspace nested
  // under the session root (folder workspaces); only fully disjoint paths are proof.
  return !isSameOrInside(session, workspace) && !isSameOrInside(workspace, session)
}
