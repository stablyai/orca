/** Scans every workspace-session partition (local + per-host) of a stopped or running profile. */
import { readPersistedProfileState } from './persisted-profile-state'

type PersistedRow = { filePath?: unknown; mirroredFromRuntimeSession?: unknown } & Record<
  string,
  unknown
>
type SessionPartition = { openFilesByWorktree?: Record<string, PersistedRow[]> } & Record<
  string,
  unknown
>
export type PersistedRoot = {
  workspaceSession?: SessionPartition
  workspaceSessionsByHostId?: Record<string, SessionPartition>
}

export type PartitionHit = { partition: string; key: string; row: PersistedRow }

export function readPartitions(userDataDir: string): Record<string, SessionPartition> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this test owns the profile; every optional field is checked at its use site.
  const root = readPersistedProfileState(userDataDir) as PersistedRoot
  const partitions: Record<string, SessionPartition> = {}
  if (root.workspaceSession) {
    partitions.local = root.workspaceSession
  }
  for (const [hostId, session] of Object.entries(root.workspaceSessionsByHostId ?? {})) {
    partitions[hostId] = session
  }
  return partitions
}

/** Finds every persisted editor row for `worktreeId` (bare or `worktree:`-prefixed key) ending in `suffix`. */
export function scanPartitions(
  userDataDir: string,
  worktreeId: string,
  suffix: string
): PartitionHit[] {
  const hits: PartitionHit[] = []
  for (const [partition, session] of Object.entries(readPartitions(userDataDir))) {
    for (const key of [worktreeId, `worktree:${worktreeId}`]) {
      for (const row of session.openFilesByWorktree?.[key] ?? []) {
        if (typeof row.filePath === 'string' && row.filePath.endsWith(suffix)) {
          hits.push({ partition, key, row })
        }
      }
    }
  }
  return hits
}
