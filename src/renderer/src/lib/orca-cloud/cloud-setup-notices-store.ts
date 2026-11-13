// Non-fatal environment-check results for an opened Orca Cloud workspace, keyed by the sandbox's
// runtime environment. The build sheet no longer stops on them (env-check-ux); the workspace shows
// each as one dismissible line with one action. Session-only: a restart re-checks nothing, and
// what was worth saying once is not re-raised.
import { useSyncExternalStore } from 'react'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { CloudSetupNotice } from '@/runtime/ephemeral-vm/ephemeral-vm-environment-check-triage'

export type CloudSetupNoticesRecord = {
  environmentId: string
  /** The checkout the doctor ran on, for re-checks. */
  path: string
  repoId: string | null
  hostId: ExecutionHostId | null
  /** https://github.com/<owner>/<repo>, or null when the project isn't on GitHub. */
  repoUrl: string | null
  notices: readonly CloudSetupNotice[]
}

type Snapshot = {
  records: Readonly<Record<string, CloudSetupNoticesRecord>>
  dismissed: ReadonlySet<string>
}

let snapshot: Snapshot = { records: {}, dismissed: new Set() }
const listeners = new Set<() => void>()

function emit(next: Snapshot): void {
  snapshot = next
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function dismissalKey(environmentId: string, noticeId: string): string {
  return `${environmentId}\0${noticeId}`
}

/** Replaces what an environment shows; an empty list clears it. */
export function setCloudSetupNotices(record: CloudSetupNoticesRecord): void {
  const records = { ...snapshot.records }
  if (record.notices.length === 0) {
    delete records[record.environmentId]
  } else {
    records[record.environmentId] = record
  }
  emit({ ...snapshot, records })
}

export function dismissCloudSetupNotice(environmentId: string, noticeId: string): void {
  const dismissed = new Set(snapshot.dismissed)
  dismissed.add(dismissalKey(environmentId, noticeId))
  emit({ ...snapshot, dismissed })
}

export function getCloudSetupNoticesRecord(
  environmentId: string
): CloudSetupNoticesRecord | undefined {
  return snapshot.records[environmentId]
}

/** Visible notices first by importance: push access, reaching GitHub, setup, tools, then disk. */
export function visibleCloudSetupNotices(
  state: Snapshot,
  environmentId: string | undefined
): readonly CloudSetupNotice[] {
  const record = environmentId ? state.records[environmentId] : undefined
  if (!record) {
    return []
  }
  const order = { environmentHeld: 0, push: 1, fetch: 2, setup: 3, tool: 4, disk: 5 } as const
  return record.notices
    .filter((notice) => !state.dismissed.has(dismissalKey(record.environmentId, notice.id)))
    .slice()
    .sort((a, b) => order[a.kind] - order[b.kind])
}

export function useCloudSetupNoticesSnapshot(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot)
}

/** Test seam. */
export function resetCloudSetupNotices(): void {
  emit({ records: {}, dismissed: new Set() })
}

// Dev builds: drive the notices from CDP (as `__store` is), e.g. to show one a repo can't produce.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  Object.assign(window, {
    __cloudSetupNotices: { get: getCloudSetupNoticesRecord, set: setCloudSetupNotices }
  })
}
