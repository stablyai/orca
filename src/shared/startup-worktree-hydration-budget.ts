import { parseWorkspaceKey } from './workspace-scope'

/** Foreground startup must stay responsive past a repo that has accumulated
 * hundreds of registered worktrees. 114 still opened; a few hundred did not. */
export const STARTUP_WORKTREE_HYDRATION_LIMIT = 128

const LAZY_WORKSPACE_STATUSES = new Set(['completed', 'todo', 'done'])

export type StartupWorktreeHydrationCandidate = {
  worktreeId: string
  isActive: boolean
  hasLiveTerminal: boolean
  automationLeftover: boolean
  workspaceStatus?: string | null
  lastVisitedAt?: number | null
}

export type StartupWorktreeHydrationPlan = {
  eagerWorktreeIds: readonly string[]
  deferredWorktreeIds: readonly string[]
  worktreeCount: number
  limit: number
  /** Set when the registered set is larger than the startup graph can hydrate. */
  overrunMessage: string | null
}

export function startupWorktreeHydrationOverrunMessage(
  worktreeCount: number,
  limit = STARTUP_WORKTREE_HYDRATION_LIMIT
): string {
  return `worktree count = ${worktreeCount}, limit = ${limit}`
}

export function startupHydrationCandidate(input: {
  worktreeId: string
  isActive: boolean
  tabs?: readonly { ptyId?: string | null }[]
  automationKind?: string | null
  workspaceStatus?: string | null
  lastVisitedAt?: number | null
}): StartupWorktreeHydrationCandidate {
  return {
    worktreeId: input.worktreeId,
    isActive: input.isActive,
    hasLiveTerminal: (input.tabs ?? []).some((tab) => Boolean(tab.ptyId)),
    automationLeftover: input.automationKind === 'created-by-automation',
    workspaceStatus: input.workspaceStatus ?? null,
    lastVisitedAt: input.lastVisitedAt ?? null
  }
}

function isLazyLeftover(candidate: StartupWorktreeHydrationCandidate): boolean {
  if (candidate.isActive || candidate.hasLiveTerminal) {
    return false
  }
  if (candidate.automationLeftover) {
    return true
  }
  return LAZY_WORKSPACE_STATUSES.has(candidate.workspaceStatus ?? '')
}

/**
 * Active workspace and live terminals stay in the startup graph. Idle, completed,
 * and automation leftovers stay on disk and load when opened. Anything still
 * over the limit is deferred so readiness does not scale with historical checkouts.
 */
export function planStartupWorktreeHydration(
  candidates: readonly StartupWorktreeHydrationCandidate[],
  limit = STARTUP_WORKTREE_HYDRATION_LIMIT
): StartupWorktreeHydrationPlan {
  const must = new Set<string>()
  const lazy: StartupWorktreeHydrationCandidate[] = []
  const flexible: StartupWorktreeHydrationCandidate[] = []
  for (const candidate of candidates) {
    if (candidate.isActive || candidate.hasLiveTerminal) {
      must.add(candidate.worktreeId)
      continue
    }
    if (isLazyLeftover(candidate)) {
      lazy.push(candidate)
      continue
    }
    flexible.push(candidate)
  }
  flexible.sort((left, right) => (right.lastVisitedAt ?? 0) - (left.lastVisitedAt ?? 0))
  const room = Math.max(0, limit - must.size)
  const eagerFlexible = flexible.slice(0, room)
  const deferredFlexible = flexible.slice(room)
  const eagerWorktreeIds = [
    ...candidates.filter((candidate) => must.has(candidate.worktreeId)).map((c) => c.worktreeId),
    ...eagerFlexible.map((candidate) => candidate.worktreeId)
  ]
  const deferredWorktreeIds = [
    ...lazy.map((candidate) => candidate.worktreeId),
    ...deferredFlexible.map((candidate) => candidate.worktreeId)
  ]
  return {
    eagerWorktreeIds,
    deferredWorktreeIds,
    worktreeCount: candidates.length,
    limit,
    overrunMessage:
      candidates.length > limit
        ? startupWorktreeHydrationOverrunMessage(candidates.length, limit)
        : null
  }
}

type SessionHydrationTab = { ptyId?: string | null }

type SessionHydrationMeta = {
  automationProvenance?: { kind: string } | null
  workspaceStatus?: string | null
}

/**
 * Full-session hydration entries that should be restored as active sessions.
 * Folder workspaces are kept; they are not registered git worktrees.
 */
export function eagerWorkspaceSessionHydrationEntries<
  T extends readonly [string, readonly SessionHydrationTab[]]
>(
  session: {
    activeWorktreeId?: string | null
    activeWorkspaceKey?: string | null
    lastVisitedAtByWorktreeId?: Readonly<Record<string, number>>
  },
  entries: readonly T[],
  readMeta: (worktreeId: string) => SessionHydrationMeta | undefined
): { entries: T[]; worktreeCount: number; overrunMessage: string | null } {
  const keptFolders: T[] = []
  const candidates: StartupWorktreeHydrationCandidate[] = []
  for (const entry of entries) {
    const [worktreeId, tabs] = entry
    if (parseWorkspaceKey(worktreeId)?.type === 'folder') {
      keptFolders.push(entry)
      continue
    }
    const meta = readMeta(worktreeId)
    candidates.push(
      startupHydrationCandidate({
        worktreeId,
        isActive:
          worktreeId === session.activeWorktreeId || worktreeId === session.activeWorkspaceKey,
        tabs,
        automationKind: meta?.automationProvenance?.kind,
        workspaceStatus: meta?.workspaceStatus,
        lastVisitedAt: session.lastVisitedAtByWorktreeId?.[worktreeId]
      })
    )
  }
  const plan = planStartupWorktreeHydration(candidates)
  const eager = new Set(plan.eagerWorktreeIds)
  return {
    entries: [...keptFolders, ...entries.filter((entry) => eager.has(entry[0]))],
    worktreeCount: candidates.length,
    overrunMessage: plan.overrunMessage
  }
}
