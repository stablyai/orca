import { useCallback, useEffect, useRef, useState } from 'react'
import type { RepoHookSettings } from '../../../../shared/orca-yaml-hook-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  areHookSettingsDraftsEqual,
  getHookSettingsDraft,
  type HookSettingsPolicyDraft,
  type LocalHookName
} from './repository/execution/repository-hook-settings-draft'

export function useRepositoryHookSettingsDraft({
  repo,
  repoHostIdentity,
  onUpdateHookSettings
}: {
  repo: Repo | undefined
  repoHostIdentity: string
  onUpdateHookSettings: (settings: RepoHookSettings) => void
}): {
  hookSettingsDraft: RepoHookSettings
  updateScriptDraft: (hookName: LocalHookName, nextScript: string) => void
  commitScriptDraft: () => void
  updateHookSettingsPolicyDraft: (updates: HookSettingsPolicyDraft) => void
} {
  const hasCurrentRepo = repo !== undefined
  const publishedHookSettings = repo?.hookSettings
  const [hookSettingsDraft, setHookSettingsDraft] = useState(() =>
    getHookSettingsDraft(repo?.hookSettings)
  )
  const hookSettingsDraftRef = useRef(hookSettingsDraft)
  const localCommandsRepoIdentityRef = useRef(repoHostIdentity)
  const localCommandsDraftDirtyRef = useRef(false)
  const localCommandsAutosaveTimerRef = useRef<number | null>(null)
  const sourceAvailableRef = useRef(Boolean(repo))
  const persistRef = useRef(onUpdateHookSettings)
  const localCommandsPersistForRepoRef = useRef(onUpdateHookSettings)

  useEffect(() => {
    persistRef.current = onUpdateHookSettings
  }, [onUpdateHookSettings])

  const syncHookSettingsDraft = useCallback((next: RepoHookSettings) => {
    if (!areHookSettingsDraftsEqual(hookSettingsDraftRef.current, next)) {
      hookSettingsDraftRef.current = next
      setHookSettingsDraft(next)
    }
  }, [])

  const clearLocalCommandsAutosaveTimer = useCallback(() => {
    if (localCommandsAutosaveTimerRef.current !== null) {
      window.clearTimeout(localCommandsAutosaveTimerRef.current)
      localCommandsAutosaveTimerRef.current = null
    }
  }, [])

  const flushScriptDraft = useCallback(
    (persistHookSettings?: (settings: RepoHookSettings) => void) => {
      clearLocalCommandsAutosaveTimer()
      if (
        !localCommandsDraftDirtyRef.current ||
        (!persistHookSettings && !sourceAvailableRef.current)
      ) {
        return
      }
      localCommandsDraftDirtyRef.current = false
      ;(persistHookSettings ?? persistRef.current)(hookSettingsDraftRef.current)
    },
    [clearLocalCommandsAutosaveTimer]
  )

  const queueScriptDraftPersist = useCallback(() => {
    localCommandsDraftDirtyRef.current = true
    clearLocalCommandsAutosaveTimer()
    // Coalesce typing bursts because repository persistence may cross SSH.
    if (sourceAvailableRef.current) {
      localCommandsAutosaveTimerRef.current = window.setTimeout(flushScriptDraft, 700)
    }
  }, [clearLocalCommandsAutosaveTimer, flushScriptDraft])

  const updateScriptDraft = useCallback(
    (hookName: LocalHookName, nextScript: string) => {
      const current = hookSettingsDraftRef.current
      const next: RepoHookSettings = {
        ...current,
        scripts: { ...current.scripts, [hookName]: nextScript }
      }
      hookSettingsDraftRef.current = next
      setHookSettingsDraft(next)
      queueScriptDraftPersist()
    },
    [queueScriptDraftPersist]
  )

  const commitScriptDraft = useCallback(() => flushScriptDraft(), [flushScriptDraft])
  const updateHookSettingsPolicyDraft = useCallback((updates: HookSettingsPolicyDraft) => {
    const next = { ...hookSettingsDraftRef.current, ...updates }
    hookSettingsDraftRef.current = next
    setHookSettingsDraft(next)
    localCommandsDraftDirtyRef.current = false
    persistRef.current(next)
  }, [])

  useEffect(() => {
    sourceAvailableRef.current = hasCurrentRepo
    if (!hasCurrentRepo) {
      clearLocalCommandsAutosaveTimer()
      return
    }
    const next = getHookSettingsDraft(publishedHookSettings)
    if (localCommandsRepoIdentityRef.current === repoHostIdentity) {
      localCommandsPersistForRepoRef.current = onUpdateHookSettings
      if (!localCommandsDraftDirtyRef.current) {
        syncHookSettingsDraft(next)
      } else {
        queueScriptDraftPersist()
      }
      return
    }
    flushScriptDraft(localCommandsPersistForRepoRef.current)
    localCommandsRepoIdentityRef.current = repoHostIdentity
    localCommandsPersistForRepoRef.current = onUpdateHookSettings
    hookSettingsDraftRef.current = next
    setHookSettingsDraft(next)
  }, [
    flushScriptDraft,
    onUpdateHookSettings,
    publishedHookSettings,
    hasCurrentRepo,
    clearLocalCommandsAutosaveTimer,
    queueScriptDraftPersist,
    repoHostIdentity,
    syncHookSettingsDraft
  ])

  useEffect(
    () => () => flushScriptDraft(localCommandsPersistForRepoRef.current),
    [flushScriptDraft]
  )

  return {
    hookSettingsDraft,
    updateScriptDraft,
    commitScriptDraft,
    updateHookSettingsPolicyDraft
  }
}
