import type { WorkspaceSessionState } from './types'
import {
  describeWorkspaceSessionError,
  safeParseWorkspaceSession,
  WORKSPACE_SESSION_UNVALIDATABLE
} from './workspace-session-schema'

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

// Why: these keys decide whether one entry contains another, so they must be a
// path identity, not a rendering of one. Map keys are user data and may hold '.',
// and an array index 3 is not the object key '3'. Defensive: under today's schema
// a joined key only costs an extra repair pass rather than losing an entry, but
// nothing about the drop planner guarantees that stays true.
function pathKey(path: readonly PropertyKey[]): string {
  return JSON.stringify(
    path.map((segment) => (typeof segment === 'symbol' ? segment.toString() : segment))
  )
}

// Why: true when some strict ancestor of `target` is already claimed, i.e. an
// outer entry is being removed and this one would vanish with it.
function hasClaimedAncestor(
  target: readonly PropertyKey[],
  claimed: ReadonlyMap<string, number>
): boolean {
  for (let i = 1; i < target.length; i += 1) {
    if (claimed.has(pathKey(target.slice(0, i)))) {
      return true
    }
  }
  return false
}

/** Why: order-independent by construction — a pass never plans a target nested
 *  inside another (see the subsumption reduction below), and a target under an
 *  already-deleted ancestor resolves to `undefined` and is skipped. Array
 *  elements are collected per parent and removed in one rebuild rather than
 *  spliced individually — a splice per element is an O(n) memmove, so a payload
 *  with thousands of bad records in one array would make repair quadratic on the
 *  startup path. */
function applyDrops(session: Record<string, unknown>, targets: readonly PropertyKey[][]): void {
  const droppedIndexesByArray = new Map<unknown[], Set<number>>()
  for (const target of targets) {
    const parent = containerAt(session, target.slice(0, -1))
    const key = target.at(-1)
    if (key === undefined) {
      continue
    }
    if (Array.isArray(parent)) {
      if (typeof key === 'number' && key < parent.length) {
        const dropped = droppedIndexesByArray.get(parent) ?? new Set<number>()
        dropped.add(key)
        droppedIndexesByArray.set(parent, dropped)
      }
      continue
    }
    if (parent != null && typeof parent === 'object' && Object.hasOwn(parent, key)) {
      delete (parent as Record<PropertyKey, unknown>)[key]
    }
  }
  for (const [array, dropped] of droppedIndexesByArray) {
    const kept = array.filter((_value, index) => !dropped.has(index))
    array.length = 0
    for (const value of kept) {
      array.push(value)
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
  let result = safeParseWorkspaceSession(raw)
  if (!result) {
    return { ok: false, error: WORKSPACE_SESSION_UNVALIDATABLE }
  }
  if (result.success) {
    return { ok: true, value: result.data, droppedPaths: [] }
  }
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: describeWorkspaceSessionError(result.error) }
  }
  const working = structuredClone(raw) as Record<string, unknown>
  // Why: one slot per repair, holding the outermost entry that repair removed, or
  // null once a later plan subsumed it. Reporting repairs rather than zod issues
  // keeps `dropped_count` telemetry a count of corrupt records, not of symptoms.
  const repairs: (PropertyKey[] | null)[] = []
  const reportedPaths = (): string[] =>
    repairs.filter((path): path is PropertyKey[] => path !== null).map((path) => path.join('.'))
  // Why: maps each entry removed last pass to its slot. An issue back at that
  // now-absent path means the drop left its parent missing a required field; that
  // escalation continues the same repair, so it replaces the slot instead of
  // logging a second entry. The absence check keeps a shifted array element at
  // the same index counting as a new entry.
  let droppedLastPass = new Map<string, number>()
  const restoredDefaultKeys = new Set<string>()

  for (let pass = 0; pass < MAX_SALVAGE_PASSES; pass += 1) {
    // Why: pass 0 reuses the parse above — `working` is a faithful clone of `raw`,
    // so re-validating a multi-MB session for the same issue set is pure startup cost.
    if (pass > 0) {
      const reparsed = safeParseWorkspaceSession(working)
      if (!reparsed) {
        return { ok: false, error: WORKSPACE_SESSION_UNVALIDATABLE }
      }
      result = reparsed
      if (result.success) {
        return { ok: true, value: result.data, droppedPaths: reportedPaths() }
      }
    }
    const plans: { target: PropertyKey[]; escalatedSlot: number | undefined }[] = []
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
      plans.push({ target, escalatedSlot })
    }
    // Why: one corrupt record raises several issues whose drop targets nest — a
    // bad field, plus the parent that field left incomplete. Claiming
    // shallowest-first lets the outermost entry own the repair and retires the
    // slots the nested ones held, so a record is reported (and counted) once.
    plans.sort((a, b) => a.target.length - b.target.length)
    const slotByTarget = new Map<string, number>()
    const claimedSlots = new Set<number>()
    const subsumedSlots = new Set<number>()
    const targets: PropertyKey[][] = []
    for (const plan of plans) {
      const targetKey = pathKey(plan.target)
      if (slotByTarget.has(targetKey) || hasClaimedAncestor(plan.target, slotByTarget)) {
        if (plan.escalatedSlot !== undefined) {
          subsumedSlots.add(plan.escalatedSlot)
        }
        continue
      }
      const slot = plan.escalatedSlot ?? repairs.length
      repairs[slot] = plan.target
      slotByTarget.set(targetKey, slot)
      claimedSlots.add(slot)
      targets.push(plan.target)
    }
    for (const slot of subsumedSlots) {
      if (!claimedSlots.has(slot)) {
        repairs[slot] = null
      }
    }
    if (targets.length === 0 && !restoredAny) {
      break
    }
    applyDrops(working, targets)
    droppedLastPass = slotByTarget
  }

  const exhausted = safeParseWorkspaceSession(working)
  if (!exhausted) {
    return { ok: false, error: WORKSPACE_SESSION_UNVALIDATABLE }
  }
  return exhausted.success
    ? { ok: true, value: exhausted.data, droppedPaths: reportedPaths() }
    : { ok: false, error: describeWorkspaceSessionError(exhausted.error) }
}
