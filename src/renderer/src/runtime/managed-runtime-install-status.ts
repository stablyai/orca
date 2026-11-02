import type { ManagedRuntimeInstallState } from '../../../shared/managed-runtime-install'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { callRuntimeRpc } from './runtime-rpc-client'
import { subscribeRuntimeRpc } from './runtime-rpc-subscribe'

/**
 * What each host says about the runtime it installs for an agent, one entry per host runtime
 * instance and agent, so Settings and a chat read the same answer. While any surface observes
 * an entry, one subscription carries the host's pushed state, idle included, so another client's
 * change shows up too; the last surface leaving ends it.
 */

export type ManagedRuntimeInstallSubject = {
  target: RuntimeClientTarget
  /** The paired host's runtime that answers; null for the local runtime. */
  runtimeId: string | null
  agent: string
}

export type ManagedRuntimeInstallSnapshot =
  | { kind: 'unknown' }
  /** No answer yet and the last read failed: says nothing about whether it is installed. */
  | { kind: 'readFailed' }
  | { kind: 'known'; state: ManagedRuntimeInstallState }

type Entry = {
  subject: ManagedRuntimeInstallSubject
  snapshot: ManagedRuntimeInstallSnapshot
  observers: number
  /** Bumped by every subscribe and every loss; a frame from another generation is stale. */
  generation: number
  /** The generation the shown state came from: revisions only order one subscription's frames. */
  shownGeneration: number
  stream: { unsubscribe: () => void } | null
  retry: ReturnType<typeof setTimeout> | null
  failures: number
}

const UNKNOWN: ManagedRuntimeInstallSnapshot = { kind: 'unknown' }

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()

const hostAgentKey = ({ target, agent }: ManagedRuntimeInstallSubject): string =>
  `${target.kind === 'local' ? '' : target.environmentId}\u0000${agent}`
const subjectKey = (subject: ManagedRuntimeInstallSubject): string =>
  `${hostAgentKey(subject)}\u0000${subject.runtimeId ?? ''}`

function setSnapshot(entry: Entry, snapshot: ManagedRuntimeInstallSnapshot): void {
  entry.snapshot = snapshot
  listeners.forEach((listener) => listener())
}

function entryFor(subject: ManagedRuntimeInstallSubject): Entry {
  const key = subjectKey(subject)
  let entry = entries.get(key)
  if (!entry) {
    // A restarted host runtime answers under a new key; the old one's answer is stale.
    for (const [otherKey, other] of entries) {
      if (other.observers === 0 && hostAgentKey(other.subject) === hostAgentKey(subject)) {
        entries.delete(otherKey)
      }
    }
    entry = {
      subject,
      snapshot: UNKNOWN,
      observers: 0,
      generation: 0,
      shownGeneration: 0,
      stream: null,
      retry: null,
      failures: 0
    }
    entries.set(key, entry)
  }
  return entry
}

function accept(entry: Entry, state: ManagedRuntimeInstallState, generation: number): void {
  // A new subscription may reach a restarted host whose revisions start again at 0.
  if (
    entry.snapshot.kind !== 'known' ||
    generation !== entry.shownGeneration ||
    entry.snapshot.state.revision < state.revision
  ) {
    entry.shownGeneration = generation
    setSnapshot(entry, { kind: 'known', state })
  }
}

const isInstallState = (value: unknown): value is ManagedRuntimeInstallState =>
  typeof value === 'object' &&
  value !== null &&
  'revision' in value &&
  typeof value.revision === 'number'

function close(entry: Entry): void {
  entry.generation += 1
  entry.stream?.unsubscribe()
  entry.stream = null
  if (entry.retry) {
    clearTimeout(entry.retry)
    entry.retry = null
  }
}

function open(entry: Entry): void {
  close(entry)
  const { generation, subject } = entry
  const current = (): boolean => entry.observers > 0 && entry.generation === generation
  const lost = (): void => {
    if (!current()) {
      return
    }
    close(entry)
    // A known answer stays through a blip; only a first read failing changes what is shown.
    if (entry.snapshot.kind !== 'known') {
      setSnapshot(entry, { kind: 'readFailed' })
    }
    entry.failures += 1
    const delay = Math.min(30_000, 1000 * 2 ** (entry.failures - 1))
    entry.retry = setTimeout(() => open(entry), delay)
  }
  void subscribeRuntimeRpc(
    subject.target,
    'managedRuntime.subscribe',
    { agent: subject.agent },
    {
      onEvent: (result) => {
        if (current() && isInstallState(result)) {
          entry.failures = 0
          accept(entry, result, generation)
        }
      },
      onError: lost,
      onClose: lost
    }
  ).then((opened) => {
    if (current()) {
      entry.stream = opened
    } else {
      opened.unsubscribe()
    }
  }, lost)
}

export function readManagedRuntimeInstall(
  subject: ManagedRuntimeInstallSubject
): ManagedRuntimeInstallSnapshot {
  return entries.get(subjectKey(subject))?.snapshot ?? UNKNOWN
}

/** Subscribes while at least one shown surface observes this subject. Returns the release. */
export function observeManagedRuntimeInstall(subject: ManagedRuntimeInstallSubject): () => void {
  const entry = entryFor(subject)
  entry.observers += 1
  if (entry.observers === 1) {
    entry.failures = 0
    open(entry)
  }
  return () => {
    entry.observers -= 1
    if (entry.observers === 0) {
      close(entry)
    }
  }
}

/** Resubscribes a lost stream at once, e.g. when the host answers again after an outage. */
export function wakeManagedRuntimeInstall(subject: ManagedRuntimeInstallSubject): void {
  const entry = entries.get(subjectKey(subject))
  if (entry?.retry) {
    entry.failures = 0
    open(entry)
  }
}

function callHost<T>(
  subject: ManagedRuntimeInstallSubject,
  method: 'managedRuntime.install' | 'managedRuntime.cancel' | 'managedRuntime.remove',
  params: Record<string, unknown>
): Promise<T> {
  return callRuntimeRpc<T>(
    subject.target,
    method,
    { agent: subject.agent, ...params },
    subject.runtimeId ? { expectedEnvironmentRuntimeId: subject.runtimeId } : {}
  )
}

async function startOperation(
  subject: ManagedRuntimeInstallSubject,
  method: 'managedRuntime.install' | 'managedRuntime.remove'
): Promise<void> {
  const entry = entryFor(subject)
  const { generation } = entry
  const state = await callHost<ManagedRuntimeInstallState>(subject, method, {})
  // A reply that crossed a resubscribe is stale; the new subscription's snapshot governs.
  if (entry.generation === generation) {
    accept(entry, state, generation)
  }
}

/** Starts, or joins, the host's install; rejects with the host's refusal. */
export function installManagedRuntime(subject: ManagedRuntimeInstallSubject): Promise<void> {
  return startOperation(subject, 'managedRuntime.install')
}

/** Resolves once the run has unwound; the subscription shows its outcome. */
export async function cancelManagedRuntimeInstall(
  subject: ManagedRuntimeInstallSubject,
  operationId: string
): Promise<void> {
  await callHost<unknown>(subject, 'managedRuntime.cancel', { operationId })
}

/** Starts, or joins, the host's removal; it fails, keeping the files, while anything may run them. */
export function removeManagedRuntime(subject: ManagedRuntimeInstallSubject): Promise<void> {
  return startOperation(subject, 'managedRuntime.remove')
}

export function subscribeManagedRuntimeInstalls(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
