import { useEffect, useMemo, useState } from 'react'
import type {
  DatabaseConnectionConfig,
  DatabaseProfileSummary,
  DatabaseTabState
} from '../../../../shared/database-types'
import {
  deleteDatabaseProfile,
  listDatabaseProfiles,
  saveDatabaseProfile
} from '@/runtime/runtime-database-client'

type UseDatabaseProfilesOptions = {
  worktreeId: string
  nodeIdentity: string
  database: DatabaseTabState
  updateDatabase: (patch: Partial<DatabaseTabState>) => void
  clearPassword: () => void
}

export function useDatabaseProfiles(options: UseDatabaseProfilesOptions): {
  profiles: DatabaseProfileSummary[]
  profileName: string
  setProfileName: (name: string) => void
  rememberPassword: boolean
  setRememberPassword: (remember: boolean) => void
  selectedProfileHasPassword: boolean
  profileError: string | null
  selectProfile: (profileId?: string) => void
  saveProfile: (password: string) => Promise<DatabaseProfileSummary>
  persistProfileConnection: (
    profile: DatabaseProfileSummary,
    connection: DatabaseConnectionConfig
  ) => Promise<DatabaseProfileSummary>
  deleteProfile: () => Promise<void>
} {
  const { worktreeId, nodeIdentity, database, updateDatabase, clearPassword } = options
  const [profiles, setProfiles] = useState<DatabaseProfileSummary[]>([])
  const [profileName, setProfileName] = useState(() => defaultProfileName(database.connection))
  const [rememberPassword, setRememberPassword] = useState(true)
  const [profileError, setProfileError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setProfileError(null)
    void listDatabaseProfiles(worktreeId)
      .then(({ profiles: loaded }) => {
        if (!active) {
          return
        }
        setProfiles(loaded)
        setProfileError(null)
      })
      .catch((error: unknown) => {
        if (active) {
          setProfileError(error instanceof Error ? error.message : String(error))
        }
      })
    return () => {
      active = false
    }
    // nodeIdentity changes when a tab moves between local/runtime/SSH owners.
  }, [worktreeId, nodeIdentity])

  useEffect(() => {
    const selected = profiles.find((profile) => profile.id === database.profileId)
    if (selected) {
      setProfileName(selected.name)
      setRememberPassword(selected.hasSavedPassword)
    }
  }, [database.profileId, profiles])

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === database.profileId),
    [database.profileId, profiles]
  )

  const selectProfile = (profileId?: string): void => {
    clearPassword()
    if (!profileId) {
      updateDatabase({ profileId: undefined })
      setProfileName(defaultProfileName(database.connection))
      setRememberPassword(true)
      return
    }
    const profile = profiles.find((candidate) => candidate.id === profileId)
    if (!profile) {
      return
    }
    updateDatabase({ profileId, connection: profile.connection })
    setProfileName(profile.name)
    setRememberPassword(profile.hasSavedPassword)
  }

  const saveProfile = async (password: string): Promise<DatabaseProfileSummary> => {
    const saved = await saveDatabaseProfile(worktreeId, {
      profile: {
        ...(database.profileId ? { id: database.profileId } : {}),
        name: profileName,
        connection: database.connection
      },
      credential: password ? { password } : {},
      credentialAction: rememberPassword ? (password ? 'save' : 'preserve') : 'delete'
    })
    setProfiles((current) => upsertProfile(current, saved))
    updateDatabase({ profileId: saved.id, connection: saved.connection })
    setProfileName(saved.name)
    setRememberPassword(rememberPassword && saved.hasSavedPassword)
    return saved
  }

  const persistProfileConnection = async (
    profile: DatabaseProfileSummary,
    connection: DatabaseConnectionConfig
  ): Promise<DatabaseProfileSummary> => {
    const saved = await saveDatabaseProfile(worktreeId, {
      profile: { id: profile.id, name: profile.name, connection },
      credential: {},
      credentialAction: 'preserve'
    })
    setProfiles((current) => upsertProfile(current, saved))
    updateDatabase({ profileId: saved.id, connection: saved.connection })
    return saved
  }

  const deleteProfile = async (): Promise<void> => {
    if (!database.profileId) {
      return
    }
    const profileId = database.profileId
    const deleted = await deleteDatabaseProfile(worktreeId, { profileId })
    if (!deleted) {
      return
    }
    setProfiles((current) => current.filter((profile) => profile.id !== profileId))
    updateDatabase({ profileId: undefined })
    clearPassword()
    setProfileName(defaultProfileName(database.connection))
    setRememberPassword(true)
  }

  return {
    profiles,
    profileName,
    setProfileName,
    rememberPassword,
    setRememberPassword,
    selectedProfileHasPassword: selectedProfile?.hasSavedPassword ?? false,
    profileError,
    selectProfile,
    saveProfile,
    persistProfileConnection,
    deleteProfile
  }
}

function defaultProfileName(connection: DatabaseConnectionConfig): string {
  return `${connection.host}/${connection.database}`
}

function upsertProfile(
  profiles: DatabaseProfileSummary[],
  saved: DatabaseProfileSummary
): DatabaseProfileSummary[] {
  return [...profiles.filter((profile) => profile.id !== saved.id), saved].sort((left, right) =>
    left.name.localeCompare(right.name)
  )
}
