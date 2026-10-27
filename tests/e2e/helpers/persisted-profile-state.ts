import { join } from 'node:path'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../../src/shared/orca-profiles'
import {
  acquireProfileStateMaintenance,
  acquireProfileStateRuntimeAdmission
} from '../../../src/main/persistence/profile-state/profile-state-access'
import { openProfileStateDatabaseReadOnly } from '../../../src/main/persistence/profile-state/profile-state-database'
import { readProfileStateParsedSnapshot } from '../../../src/main/persistence/profile-state/profile-state-documents'
import { parseProfileStateRoot } from '../../../src/main/persistence/profile-state/profile-state-document-validation'
import { ProfileStateSqliteAuthority } from '../../../src/main/persistence/profile-state/profile-state-sqlite-authority'

/** Read committed storage without consulting a retained migration JSON snapshot. */
export function readPersistedProfileState(
  userDataDir: string,
  profileId = DEFAULT_LOCAL_ORCA_PROFILE_ID
): Record<string, unknown> {
  const admission = acquireProfileStateRuntimeAdmission(userDataDir)
  try {
    const opened = openProfileStateDatabaseReadOnly(
      join(userDataDir, 'profiles', profileId, 'profile-state.db'),
      profileId
    )
    try {
      return readProfileStateParsedSnapshot(opened.db).state
    } finally {
      opened.db.close()
    }
  } finally {
    admission.release()
  }
}

/** Seed restart artifacts only while no runtime or other fixture writer owns the profile. */
export function mutateStoppedProfileState<T>(
  userDataDir: string,
  mutate: (state: Record<string, unknown>) => T,
  profileId = DEFAULT_LOCAL_ORCA_PROFILE_ID
): T {
  const maintenance = acquireProfileStateMaintenance(userDataDir)
  const authority = new ProfileStateSqliteAuthority(
    join(userDataDir, 'profiles', profileId, 'profile-state.db'),
    profileId
  )
  try {
    const serialized = authority.readSerializedState()
    if (serialized === undefined) {
      throw new Error('Expected an established profile before seeding restart state')
    }
    const state = parseProfileStateRoot(serialized)
    const result = mutate(state)
    authority.writeSerializedState(Buffer.from(JSON.stringify(state)))
    return result
  } finally {
    try {
      authority.close()
    } finally {
      maintenance.release()
    }
  }
}
