import type { WorkspaceSessionState } from './types'
import { parseWorkspaceSession, workspaceSessionStateSchema } from './workspace-session-schema'

// Why: a corrupted record is usually one entry (one tab, one layout, one map value),
// while a genuinely foreign payload fails everywhere at once — a small budget separates
// the two without risking an unbounded prune loop.
const MAX_SALVAGE_DROPS = 32

export type SalvagedWorkspaceSession =
  | { ok: true; value: WorkspaceSessionState; droppedPaths: string[] }
  | { ok: false; error: string }

function containerAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let node: unknown = root
  for (const key of path) {
    if (node == null || typeof node !== 'object') {
      return undefined
    }
    node = (node as Record<PropertyKey, unknown>)[key]
  }
  return node
}

/** Remove the smallest self-contained entry containing the issue: the innermost
 *  array element on the path, else the innermost removable object entry.
 *  Why: deleting the innermost entry first is safe without schema knowledge — if
 *  that leaves a required field missing, the caller's re-parse escalates to the
 *  containing entry on the next pass.
 *  Returns the dropped path segments, or null when nothing removable remains. */
function dropIssueEntry(
  session: Record<string, unknown>,
  path: readonly PropertyKey[]
): PropertyKey[] | null {
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const key = path[i]
    const parent = containerAt(session, path.slice(0, i))
    if (Array.isArray(parent) && typeof key === 'number' && key < parent.length) {
      parent.splice(key, 1)
      return path.slice(0, i + 1)
    }
  }
  for (let i = path.length; i >= 1; i -= 1) {
    const parent = containerAt(session, path.slice(0, i - 1))
    if (
      parent != null &&
      typeof parent === 'object' &&
      !Array.isArray(parent) &&
      Object.hasOwn(parent, path[i - 1])
    ) {
      delete (parent as Record<PropertyKey, unknown>)[path[i - 1]]
      return path.slice(0, i)
    }
  }
  return null
}

// Why: segment-wise comparison — joined strings would collide when a map key
// itself contains a '.', letting an unrelated corruption pose as an escalation.
function samePath(a: readonly PropertyKey[], b: readonly PropertyKey[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index])
}

/** Validate like parseWorkspaceSession, but on failure drop the individual
 *  offending entries and keep the rest of the session instead of discarding it
 *  wholesale — one bad tab record must not cost every worktree's state. */
export function parseWorkspaceSessionSalvaging(raw: unknown): SalvagedWorkspaceSession {
  const first = parseWorkspaceSession(raw)
  if (first.ok) {
    return { ok: true, value: first.value, droppedPaths: [] }
  }
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return first
  }
  const working = structuredClone(raw) as Record<string, unknown>
  const droppedPaths: string[] = []
  let lastDropped: PropertyKey[] | null = null
  for (let attempt = 0; attempt < MAX_SALVAGE_DROPS; ) {
    const result = workspaceSessionStateSchema.safeParse(working)
    if (result.success) {
      return { ok: true, value: result.data, droppedPaths }
    }
    const issue = result.error.issues[0]
    if (!issue) {
      break
    }
    // Why: an issue at the just-dropped, now-absent path means the drop left its
    // parent missing a required field — that escalation continues the same repair,
    // so it neither consumes budget (a systemic single-field corruption would
    // exhaust it and force the full reset this module exists to avoid) nor logs a
    // second entry: the last dropped path is replaced so droppedPaths reports the
    // final self-contained entry each repair removed. The absence check keeps a
    // shifted array element at the same index counting as a new entry. Each pass
    // still deletes a key, so the loop stays finite.
    const isEscalation =
      lastDropped !== null &&
      samePath(issue.path, lastDropped) &&
      containerAt(working, issue.path) === undefined
    const dropped = dropIssueEntry(working, issue.path)
    if (!dropped) {
      break
    }
    if (isEscalation) {
      droppedPaths[droppedPaths.length - 1] = dropped.join('.')
    } else {
      attempt += 1
      droppedPaths.push(dropped.join('.'))
    }
    lastDropped = dropped
  }
  const exhausted = parseWorkspaceSession(working)
  return exhausted.ok ? { ok: true, value: exhausted.value, droppedPaths } : exhausted
}
