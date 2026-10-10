import {
  callCodexMaintenance,
  codexMaintenanceTargetKey,
  type CodexMaintenanceTarget
} from './codex-maintenance-client'
import type { CodexMaintenanceState } from '../../../shared/codex-cli-maintenance'
import { useAppStore } from '@/store'
import {
  codexMaintenanceEvidenceExpiry,
  EMPTY,
  type CodexMaintenanceEntry
} from './codex-maintenance-snapshot'
import { CodexMaintenanceActivity } from './codex-maintenance-activity'

let entries: ReadonlyMap<string, CodexMaintenanceEntry> = new Map()
let logTarget: CodexMaintenanceTarget | null = null
const listeners = new Set<() => void>()
const reads = new Map<string, Promise<void>>()
const polls = new Map<string, ReturnType<typeof setTimeout>>()
const revisions = new Map<string, number>()
const starts = new Map<string, object>()
const hosts = new Map<string, string>()
const activities = new CodexMaintenanceActivity()
let revisionId = 0

function rememberTarget(target: CodexMaintenanceTarget): string {
  const key = codexMaintenanceTargetKey(target)
  hosts.set(key, codexMaintenanceTargetKey({ ...target, cwd: undefined }))
  return key
}

export function getCodexMaintenanceHostBusy(target: CodexMaintenanceTarget): boolean {
  const host = codexMaintenanceTargetKey({ ...target, cwd: undefined })
  return activities.isBusy(host) || [...starts.keys()].some((key) => hosts.get(key) === host)
}

function nextRevision(key: string): number {
  const revision = ++revisionId
  revisions.set(key, revision)
  return revision
}

function publish(key: string, patch: Partial<CodexMaintenanceEntry>): void {
  const next = new Map(entries).set(key, { ...getCodexMaintenanceEntry(key), ...patch })
  for (const [id, entry] of next) {
    if (next.size <= 64) {
      break
    }
    if (id !== key && !entry.starting && !polls.has(id)) {
      next.delete(id)
      revisions.delete(id)
      const oldHost = hosts.get(id)
      hosts.delete(id)
      if (oldHost && ![...hosts.values()].includes(oldHost)) {
        activities.delete(oldHost)
      }
    }
  }
  entries = next
  for (const listener of listeners) {
    listener()
  }
}

function acceptState(
  key: string,
  state: CodexMaintenanceState,
  revision: number,
  requestedAt: number,
  historical = false
): void {
  const host = hosts.get(key)
  if (host) {
    activities.reconcile(host, state, revision, historical)
  }
  const now = Date.now()
  const evidence = state.evidence
  const expiresAt = codexMaintenanceEvidenceExpiry(evidence, requestedAt)
  publish(key, {
    state,
    expiresAt,
    ...(state.job ? { logJob: state.job } : {}),
    error: null,
    verification: evidence && expiresAt > now ? 'current' : 'unverifiable'
  })
}

function publishFailure(key: string, error: unknown, revision: number): void {
  const message = error instanceof Error ? error.message : String(error)
  const host = hosts.get(key)
  if (host) {
    activities.recordFailure(host, revision, message)
  }
  publish(key, { error: message, verification: 'unverifiable' })
}

export function subscribeCodexMaintenance(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function getCodexMaintenanceEntry(key: string): CodexMaintenanceEntry {
  const entry = entries.get(key) ?? EMPTY
  if (entry.verification === 'current' && entry.expiresAt <= Date.now()) {
    const withdrawn: CodexMaintenanceEntry = { ...entry, verification: 'unverifiable' }
    entries = new Map(entries).set(key, withdrawn)
    return withdrawn
  }
  return entry
}
export function getCodexMaintenanceLogTarget(): CodexMaintenanceTarget | null {
  return logTarget
}
export function openCodexMaintenanceLog(target: CodexMaintenanceTarget | null): void {
  logTarget = target
  for (const listener of listeners) {
    listener()
  }
}

function scheduleRead(target: CodexMaintenanceTarget, jobId: string, failures = 0): void {
  const key = rememberTarget(target)
  clearTimeout(polls.get(key))
  polls.set(
    key,
    setTimeout(() => {
      polls.delete(key)
      if (starts.has(key)) {
        return
      }
      const revision = nextRevision(key)
      const requestedAt = Date.now()
      void callCodexMaintenance(target, { operation: 'read', jobId })
        .then((state) => {
          if (revisions.get(key) !== revision) {
            return
          }
          acceptState(key, state, revision, requestedAt, true)
          if (activities.isSuperseded(hosts.get(key) ?? '', revision)) {
            return
          }
          if (
            state.job &&
            getCodexMaintenanceHostBusy(target) &&
            (state.currentJob === undefined || state.currentJob?.id === state.job.id) &&
            (state.job.phase === 'queued' || state.job.phase === 'running')
          ) {
            scheduleRead(target, jobId)
          } else {
            refreshDetectedAgents(target)
            if (state.currentJob === undefined) {
              void refreshCodexMaintenance(target)
            }
          }
        })
        .catch((error: unknown) => {
          if (revisions.get(key) !== revision) {
            return
          }
          publishFailure(key, error, revision)
          if (failures < 2) {
            scheduleRead(target, jobId, failures + 1)
          }
        })
    }, 1_000)
  )
}

function refreshDetectedAgents(target: CodexMaintenanceTarget): void {
  const store = useAppStore.getState()
  const refresh =
    target.kind === 'environment'
      ? store.refreshRuntimeDetectedAgents(target.environmentId)
      : store.refreshDetectedAgents()
  void refresh.catch(() => {})
}

export function refreshCodexMaintenance(target: CodexMaintenanceTarget): Promise<void> {
  const key = rememberTarget(target)
  const pending = reads.get(key)
  if (getCodexMaintenanceEntry(key).starting) {
    return Promise.resolve()
  }
  if (pending) {
    return pending
  }
  clearTimeout(polls.get(key))
  polls.delete(key)
  const revision = nextRevision(key)
  const requestedAt = Date.now()
  publish(key, { verification: 'checking' })
  const read = callCodexMaintenance(target, { operation: 'status' })
    .then((state) => {
      if (revisions.get(key) !== revision) {
        return
      }
      acceptState(key, state, revision, requestedAt)
      if (state.job && (state.job.phase === 'queued' || state.job.phase === 'running')) {
        scheduleRead(target, state.job.id)
      }
    })
    .catch((error: unknown) => {
      if (revisions.get(key) !== revision) {
        return
      }
      // An unavailable host does not prove a missing or old CLI.
      publishFailure(key, error, revision)
    })
    .finally(() => {
      if (reads.get(key) === read) {
        reads.delete(key)
      }
    })
  reads.set(key, read)
  return read
}

export function invalidateCodexMaintenanceContact(target: CodexMaintenanceTarget): void {
  const key = rememberTarget(target)
  nextRevision(key)
  clearTimeout(polls.get(key))
  polls.delete(key)
  reads.delete(key)
  publish(key, { verification: 'unverifiable' })
}

export function startCodexMaintenance(target: CodexMaintenanceTarget): void {
  const key = rememberTarget(target)
  openCodexMaintenanceLog(target)
  if (getCodexMaintenanceHostBusy(target)) {
    return
  }
  clearTimeout(polls.get(key))
  polls.delete(key)
  const request = {}
  starts.set(key, request)
  publish(key, { starting: true, error: null, verification: 'checking' })
  const revision = nextRevision(key)
  const requestedAt = Date.now()
  void callCodexMaintenance(target, { operation: 'start' })
    .then((state) => {
      if (starts.get(key) !== request || revisions.get(key) !== revision) {
        return
      }
      acceptState(key, state, revision, requestedAt)
      if (state.job && (state.job.phase === 'queued' || state.job.phase === 'running')) {
        scheduleRead(target, state.job.id)
      }
    })
    .catch((error: unknown) => {
      if (revisions.get(key) !== revision) {
        return
      }
      publishFailure(key, error, revision)
    })
    .finally(() => {
      if (starts.get(key) === request) {
        starts.delete(key)
        publish(key, { starting: false })
        if (revisions.get(key) !== revision) {
          void refreshCodexMaintenance(target)
        }
      }
    })
}

export function resetCodexMaintenanceStoreForTests(): void {
  for (const timer of polls.values()) {
    clearTimeout(timer)
  }
  polls.clear()
  reads.clear()
  starts.clear()
  hosts.clear()
  activities.clear()
  revisions.clear()
  entries = new Map()
  logTarget = null
}
