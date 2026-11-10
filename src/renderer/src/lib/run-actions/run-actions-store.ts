import { useSyncExternalStore } from 'react'

/** `stopping` waits for the process to leave after an interrupt; `stopped` was the user's doing. */
export type RunActionStatus = 'running' | 'stopping' | 'stopped' | 'exited' | 'failed'

export type RunActionRun = {
  worktreeId: string
  repoId: string
  actionId: string
  actionName: string
  /** The terminal tab showing this run's output. */
  tabId: string
  status: RunActionStatus
  exitCode: number | null
  startedAt: number
}

type RunsByWorktree = Record<string, Record<string, RunActionRun>>

const STORAGE_KEY = 'orca.runActions.v1'

let runs: RunsByWorktree = readPersisted()
const listeners = new Set<() => void>()

function readPersisted(): RunsByWorktree {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return sanitizePersisted(parsed)
  } catch {
    return {}
  }
}

const STATUSES: readonly RunActionStatus[] = ['running', 'stopping', 'stopped', 'exited', 'failed']

function readRun(value: unknown): RunActionRun | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const run: Record<string, unknown> = { ...value }
  const { worktreeId, repoId, actionId, actionName, tabId, status, exitCode, startedAt } = run
  if (
    typeof worktreeId !== 'string' ||
    typeof repoId !== 'string' ||
    typeof actionId !== 'string' ||
    typeof actionName !== 'string' ||
    typeof tabId !== 'string' ||
    typeof startedAt !== 'number' ||
    !STATUSES.some((known) => known === status)
  ) {
    return null
  }
  return {
    worktreeId,
    repoId,
    actionId,
    actionName,
    tabId,
    status: STATUSES.find((known) => known === status) ?? 'exited',
    exitCode: typeof exitCode === 'number' ? exitCode : null,
    startedAt
  }
}

/** Storage is outside our control (older builds, hand edits): keep only well-formed runs. */
function sanitizePersisted(value: unknown): RunsByWorktree {
  const out: RunsByWorktree = {}
  if (typeof value !== 'object' || value === null) {
    return out
  }
  for (const byAction of Object.values(value)) {
    if (typeof byAction !== 'object' || byAction === null) {
      continue
    }
    for (const entry of Object.values(byAction)) {
      const run = readRun(entry)
      if (run) {
        ;(out[run.worktreeId] ??= {})[run.actionId] = run
      }
    }
  }
  return out
}

function persist(): void {
  try {
    // Only live runs matter after a reload: they are what a wake or restart brings back.
    const live: RunsByWorktree = {}
    for (const [worktreeId, byAction] of Object.entries(runs)) {
      for (const [actionId, run] of Object.entries(byAction)) {
        if (run.status === 'running') {
          ;(live[worktreeId] ??= {})[actionId] = run
        }
      }
    }
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(live))
  } catch {
    // Storage is best effort; the in-memory state stays authoritative.
  }
}

function emit(): void {
  persist()
  for (const listener of listeners) {
    listener()
  }
}

export function getRunActionRuns(): RunsByWorktree {
  return runs
}

export function getRunActionRun(worktreeId: string, actionId: string): RunActionRun | null {
  return runs[worktreeId]?.[actionId] ?? null
}

export function listRunActionRuns(): RunActionRun[] {
  return Object.values(runs).flatMap((byAction) => Object.values(byAction))
}

export function findRunActionRunByTab(tabId: string): RunActionRun | null {
  return listRunActionRuns().find((run) => run.tabId === tabId) ?? null
}

export function setRunActionRun(run: RunActionRun): void {
  runs = { ...runs, [run.worktreeId]: { ...runs[run.worktreeId], [run.actionId]: run } }
  emit()
}

export function patchRunActionRun(
  worktreeId: string,
  actionId: string,
  patch: Partial<Pick<RunActionRun, 'status' | 'exitCode'>>
): void {
  const current = runs[worktreeId]?.[actionId]
  if (!current) {
    return
  }
  setRunActionRun({ ...current, ...patch })
}

export function deleteRunActionRun(worktreeId: string, actionId: string): void {
  const byAction = runs[worktreeId]
  if (!byAction?.[actionId]) {
    return
  }
  const { [actionId]: _removed, ...rest } = byAction
  const next = { ...runs }
  if (Object.keys(rest).length > 0) {
    next[worktreeId] = rest
  } else {
    delete next[worktreeId]
  }
  runs = next
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const EMPTY: Record<string, RunActionRun> = {}

export function useWorktreeRunActionRuns(
  worktreeId: string | null | undefined
): Record<string, RunActionRun> {
  return useSyncExternalStore(subscribe, () => (worktreeId ? (runs[worktreeId] ?? EMPTY) : EMPTY))
}

/** Test-only reset. */
export function resetRunActionRunsForTests(): void {
  runs = {}
  listeners.clear()
}
