import { useCallback, useEffect, useRef, useState } from 'react'
import type { RepoHookSettings } from '../../../../shared/orca-yaml-hook-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  areHookSettingsDraftsEqual,
  getHookSettingsDraft,
  type HookSettingsPolicyDraft,
  type LocalHookName
} from './repository-hook-settings-draft'

export function useRepositoryHookSettingsDraft({
  repo,
  repoHostIdentity,
  onUpdateHookSettings
}: {
  repo: Repo
  repoHostIdentity: string
  onUpdateHookSettings: (settings: RepoHookSettings) => void
}): {
  hookSettingsDraft: RepoHookSettings
  updateScriptDraft: (hookName: LocalHookName, nextScript: string) => void
  commitScriptDraft: () => void
  flushScriptDraftOnUnmount: (node: HTMLElement | null) => void
  updateHookSettingsPolicyDraft: (updates: HookSettingsPolicyDraft) => void
} {
  const [hookSettingsDraft, setHookSettingsDraft] = useState(() =>
    getHookSettingsDraft(repo.hookSettings)
  )
  const hookSettingsDraftRef = useRef(hookSettingsDraft)
  const localCommandsRepoIdentityRef = useRef(repoHostIdentity)
  const localCommandsDraftDirtyRef = useRef(false)
  const localCommandsAutosaveTimerRef = useRef<number | null>(null)
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
      if (!localCommandsDraftDirtyRef.current) {
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
    // Why: repo persistence may be an SSH RPC; coalesce typing bursts.
    localCommandsAutosaveTimerRef.current = window.setTimeout(flushScriptDraft, 700)
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
  const flushScriptDraftOnUnmount = useCallback(
    (node: HTMLElement | null): void => {
      if (node === null) {
        flushScriptDraft()
      }
    },
    [flushScriptDraft]
  )
  const updateHookSettingsPolicyDraft = useCallback((updates: HookSettingsPolicyDraft) => {
    const next = { ...hookSettingsDraftRef.current, ...updates }
    hookSettingsDraftRef.current = next
    setHookSettingsDraft(next)
    localCommandsDraftDirtyRef.current = false
    persistRef.current(next)
  }, [])

  useEffect(() => {
    const next = getHookSettingsDraft(repo.hookSettings)
    if (localCommandsRepoIdentityRef.current === repoHostIdentity) {
      localCommandsPersistForRepoRef.current = onUpdateHookSettings
      if (!localCommandsDraftDirtyRef.current) {
        syncHookSettingsDraft(next)
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
    repo.hookSettings,
    repoHostIdentity,
    syncHookSettingsDraft
  ])

  return {
    hookSettingsDraft,
    updateScriptDraft,
    commitScriptDraft,
    flushScriptDraftOnUnmount,
    updateHookSettingsPolicyDraft
  }
}
