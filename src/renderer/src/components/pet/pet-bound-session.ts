/**
 * The pet's bound session — which omp tab this pet is *its* assistant.
 *
 * Why this exists at all: agent status cannot answer "does the pet have an
 * assistant yet". A freshly spawned omp pane reports `agents: []` until its
 * first prompt, so a pet that discovered its session only through
 * `AgentStatusEntry` would spawn one and then still offer nothing but "spawn"
 * — which is exactly the dead end this fixes. The binding is recorded at spawn
 * time from the tab we created, so the pet can be asked immediately, before the
 * assistant has ever spoken.
 *
 * Kept as a tiny external store rather than a slice of the app store because
 * the binding is pet state, not workspace state, and the presence refactor
 * (PetPresence -> PetPresence[]) will want to key it per pet. One module-level
 * record is the smallest thing that survives that change.
 */

const STORAGE_KEY = 'orca.pet.boundSession.v1'

export type PetBoundSession = {
  tabId: string
  worktreeId: string
}

let boundSession: PetBoundSession | null = readPersisted()
const listeners = new Set<() => void>()

function readPersisted(): PetBoundSession | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as Partial<PetBoundSession> | null
    if (!parsed?.tabId || !parsed.worktreeId) {
      return null
    }
    return { tabId: parsed.tabId, worktreeId: parsed.worktreeId }
  } catch {
    // A corrupt or unavailable store must not wall the pet in — worst case the
    // pet forgets its assistant and offers to spawn another.
    return null
  }
}

function persist(session: PetBoundSession | null): void {
  try {
    if (session) {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(session))
    } else {
      globalThis.localStorage?.removeItem(STORAGE_KEY)
    }
  } catch {
    // Non-fatal: the binding still works for this session.
  }
}

export function getPetBoundSession(): PetBoundSession | null {
  return boundSession
}

export function setPetBoundSession(session: PetBoundSession | null): void {
  boundSession = session
  persist(session)
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeToPetBoundSession(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Resolve the binding to something sendable, or null if the tab is gone.
 *
 * The staleness check is the point: a bound tab the user closed must not keep
 * the pet offering "Ask", and must fall back to offering a fresh spawn.
 */
export function resolvePetBoundNoteTarget(
  session: PetBoundSession | null,
  state: {
    terminalLayoutsByTabId: Record<string, { activeLeafId: string | null } | undefined>
    tabsByWorktree: Record<string, readonly { id: string }[] | undefined>
  }
): { worktreeId: string; noteTarget: { tabId: string; leafId: string } } | null {
  if (!session) {
    return null
  }
  const tabStillOpen = (state.tabsByWorktree[session.worktreeId] ?? []).some(
    (tab) => tab.id === session.tabId
  )
  if (!tabStillOpen) {
    return null
  }
  const leafId = state.terminalLayoutsByTabId[session.tabId]?.activeLeafId
  if (!leafId) {
    return null
  }
  return { worktreeId: session.worktreeId, noteTarget: { tabId: session.tabId, leafId } }
}
