import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { isWorkspaceSessionRecord } from '../../../shared/workspace-session-host-records'

/** Workspace ids each workspace-keyed session field last held on disk, as far as this client
 *  wrote or read it. A key that drops out of a later write names the one partition holding a
 *  row nothing else will overwrite. */
export type PersistedWorkspaceKeysByField = Map<keyof WorkspaceSessionState, ReadonlySet<string>>

/** The given workspace-keyed fields `session` carries, with the workspace ids each one holds. */
export function workspaceKeysByField(
  session: Partial<WorkspaceSessionState>,
  fields: readonly (keyof WorkspaceSessionState)[]
): PersistedWorkspaceKeysByField {
  const keys: PersistedWorkspaceKeysByField = new Map()
  for (const field of fields) {
    const value = session[field]
    if (isWorkspaceSessionRecord(value)) {
      keys.set(field, new Set(Object.keys(value)))
    }
  }
  return keys
}

/** Keys the last write held that `value` no longer does. */
export function removedWorkspaceKeys(
  value: unknown,
  previousKeys: ReadonlySet<string> | undefined
): string[] {
  if (!previousKeys || !isWorkspaceSessionRecord(value)) {
    return []
  }
  return [...previousKeys].filter((key) => !Object.hasOwn(value, key))
}

export function recordPersistedWorkspaceKeys(
  ledger: PersistedWorkspaceKeysByField,
  written: PersistedWorkspaceKeysByField
): void {
  for (const [field, keys] of written) {
    ledger.set(field, keys)
  }
}

/** The renderer's one ledger: seeded from the startup read, advanced by each settled session write. */
export const persistedWorkspaceSessionKeys: PersistedWorkspaceKeysByField = new Map()

export function seedPersistedWorkspaceSessionKeys(
  session: WorkspaceSessionState,
  fields: readonly (keyof WorkspaceSessionState)[]
): void {
  recordPersistedWorkspaceKeys(persistedWorkspaceSessionKeys, workspaceKeysByField(session, fields))
}
