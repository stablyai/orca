import type { WorkspaceSessionState } from './types'
import { parseWorkspaceSession, workspaceSessionStateSchema } from './workspace-session-schema'

// Why: each pass drops every corrupt entry zod reported, so N bad records
// converge in a couple of passes regardless of N. The cap only bounds a payload
// whose repair keeps uncovering new damage; escalating from a field to its
// containing record is the deepest real chain, so this is generous headroom.
const MAX_SALVAGE_PASSES = 8

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

/** Path of the smallest self-contained entry containing the issue: the innermost
 *  array element on the path, else the innermost removable object entry.
 *  Why: targeting the innermost entry first is safe without schema knowledge — if
 *  that leaves a required field missing, the next pass escalates to the
 *  containing entry. Pure, so a whole pass is planned before anything mutates.
 *  Returns null when nothing on the path remains removable. */
function findDropTarget(
  session: Record<string, unknown>,
  path: readonly PropertyKey[]
): PropertyKey[] | null {
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const key = path[i]
    const parent = containerAt(session, path.slice(0, i))
    if (Array.isArray(parent) && typeof key === 'number' && key < parent.length) {
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
      return path.slice(0, i)
    }
  }
  return null
}

// Why: segment-wise identity — joined strings would collide when a map key itself
// contains a '.', letting an unrelated corruption pose as an escalation.
function pathKey(path: readonly PropertyKey[]): string {
  return JSON.stringify(
    path.map((segment) => (typeof segment === 'symbol' ? segment.toString() : segment))
  )
}

function comparePaths(a: readonly PropertyKey[], b: readonly PropertyKey[]): number {
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i += 1) {
    if (a[i] === b[i]) {
      continue
    }
    if (typeof a[i] === 'number' && typeof b[i] === 'number') {
      return (a[i] as number) - (b[i] as number)
    }
    return String(a[i]) < String(b[i]) ? -1 : 1
  }
  return a.length - b.length
}

/** Why: descending path order removes deeper and later-indexed entries first, so
 *  an array splice never shifts an index another planned target still points at. */
function applyDrops(session: Record<string, unknown>, targets: readonly PropertyKey[][]): void {
  for (const target of [...targets].sort((a, b) => comparePaths(b, a))) {
    const parent = containerAt(session, target.slice(0, -1))
    const key = target.at(-1)
    if (key === undefined) {
      continue
    }
    if (Array.isArray(parent)) {
      if (typeof key === 'number' && key < parent.length) {
        parent.splice(key, 1)
      }
      continue
    }
    if (parent != null && typeof parent === 'object' && Object.hasOwn(parent, key)) {
      delete (parent as Record<PropertyKey, unknown>)[key]
    }
  }
}

/** Validate like parseWorkspaceSession, but on failure drop the individual
 *  offending entries and keep the rest of the session instead of discarding it
 *  wholesale — one bad tab record must not cost every worktree's state.
 *  `defaults` lets a dropped *required* top-level field fall back to its default
 *  value rather than resetting the session the caller was trying to preserve. */
export function parseWorkspaceSessionSalvaging(
  raw: unknown,
  defaults?: WorkspaceSessionState
): SalvagedWorkspaceSession {
  const first = parseWorkspaceSession(raw)
  if (first.ok) {
    return { ok: true, value: first.value, droppedPaths: [] }
  }
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return first
  }
  const working = structuredClone(raw) as Record<string, unknown>
  const droppedPaths: string[] = []
  // Why: maps each entry removed last pass to its slot in droppedPaths. An issue
  // back at that now-absent path means the drop left its parent missing a
  // required field; that escalation continues the same repair, so it replaces
  // the slot instead of logging a second entry — droppedPaths reports the final
  // self-contained record each repair removed, and the absence check keeps a
  // shifted array element at the same index counting as a new entry.
  let droppedLastPass = new Map<string, number>()
  const restoredDefaultKeys = new Set<string>()

  for (let pass = 0; pass < MAX_SALVAGE_PASSES; pass += 1) {
    const result = workspaceSessionStateSchema.safeParse(working)
    if (result.success) {
      return { ok: true, value: result.data, droppedPaths }
    }
    const droppedThisPass = new Map<string, number>()
    const targets: PropertyKey[][] = []
    let restoredAny = false
    for (const issue of result.error.issues) {
      const escalatedSlot =
        containerAt(working, issue.path) === undefined
          ? droppedLastPass.get(pathKey(issue.path))
          : undefined
      const target = findDropTarget(working, issue.path)
      if (!target) {
        // Why: nothing removable left on this path means the drop emptied a
        // required top-level field. Restoring the caller's default keeps every
        // other worktree's tabs, layouts and sleeping agents instead of resetting
        // the whole session over one bad field. Gated on escalatedSlot so a
        // foreign payload — required fields simply absent, never dropped by us —
        // still reports unsalvageable rather than posing as a repaired session.
        const key = issue.path[0]
        if (
          defaults !== undefined &&
          escalatedSlot !== undefined &&
          issue.path.length === 1 &&
          typeof key === 'string' &&
          Object.hasOwn(defaults, key) &&
          !restoredDefaultKeys.has(key)
        ) {
          restoredDefaultKeys.add(key)
          working[key] = structuredClone((defaults as Record<string, unknown>)[key])
          restoredAny = true
        }
        continue
      }
      const targetKey = pathKey(target)
      if (droppedThisPass.has(targetKey)) {
        continue
      }
      if (escalatedSlot === undefined) {
        droppedThisPass.set(targetKey, droppedPaths.length)
        droppedPaths.push(target.join('.'))
      } else {
        droppedPaths[escalatedSlot] = target.join('.')
        droppedThisPass.set(targetKey, escalatedSlot)
      }
      targets.push(target)
    }
    if (targets.length === 0 && !restoredAny) {
      break
    }
    applyDrops(working, targets)
    droppedLastPass = droppedThisPass
  }

  const exhausted = parseWorkspaceSession(working)
  return exhausted.ok ? { ok: true, value: exhausted.value, droppedPaths } : exhausted
}
