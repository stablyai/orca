import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  areAppearanceSettingValuesEqual,
  getAppearanceDraftChangedKeys,
  getAppearanceDraftChanges
} from './appearance-draft-diff'

type UseAppearanceSettingsDraftOptions = {
  settings: GlobalSettings | null
  persistSettings: (updates: Partial<GlobalSettings>) => Promise<void>
  applyTheme: (theme: GlobalSettings['theme']) => void
}

export type AppearanceSettingsDraft = {
  settings: GlobalSettings | null
  changedKeys: (keyof GlobalSettings)[]
  hasChanges: boolean
  saving: boolean
  saveFailed: boolean
  stage: (updates: Partial<GlobalSettings>) => void
  save: () => Promise<boolean>
  discard: () => void
}

export function useAppearanceSettingsDraft({
  settings,
  persistSettings,
  applyTheme
}: UseAppearanceSettingsDraftOptions): AppearanceSettingsDraft {
  const [draft, setDraft] = useState<Partial<GlobalSettings>>({})
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const settingsRef = useRef(settings)
  const draftRef = useRef(draft)
  const savePromiseRef = useRef<Promise<boolean> | null>(null)

  useEffect(() => {
    settingsRef.current = settings
    draftRef.current = draft
  }, [draft, settings])

  const changes = useMemo(
    () => (settings ? getAppearanceDraftChanges(settings, draft) : {}),
    [draft, settings]
  )
  const changedKeys = useMemo(
    () => (settings ? getAppearanceDraftChangedKeys(settings, draft) : []),
    [draft, settings]
  )
  const effectiveSettings = useMemo(
    () => (settings ? { ...settings, ...changes } : null),
    [changes, settings]
  )

  const stage = useCallback((updates: Partial<GlobalSettings>): void => {
    const base = settingsRef.current
    if (!base) {
      return
    }
    setSaveFailed(false)
    const next = { ...draftRef.current, ...updates }
    const rebased = savePromiseRef.current ? next : getAppearanceDraftChanges(base, next)
    draftRef.current = rebased
    setDraft(rebased)
  }, [])

  const discard = useCallback((): void => {
    if (savePromiseRef.current) {
      return
    }
    draftRef.current = {}
    setDraft(draftRef.current)
    setSaveFailed(false)
  }, [])

  const save = useCallback((): Promise<boolean> => {
    if (savePromiseRef.current) {
      return savePromiseRef.current
    }
    const base = settingsRef.current
    if (!base) {
      return Promise.resolve(true)
    }
    const patch = getAppearanceDraftChanges(base, draftRef.current)
    const keys = Object.keys(patch) as (keyof GlobalSettings)[]
    if (keys.length === 0) {
      return Promise.resolve(true)
    }

    setSaving(true)
    setSaveFailed(false)
    let persistence: Promise<void>
    try {
      persistence = persistSettings(patch)
    } catch (error) {
      persistence = Promise.reject(error)
    }
    const pending = persistence
      .then(() => {
        if (patch.theme) {
          applyTheme(patch.theme)
        }
        const next = { ...draftRef.current }
        for (const key of keys) {
          if (areAppearanceSettingValuesEqual(next[key], patch[key])) {
            delete next[key]
          }
        }
        const savedBase = { ...(settingsRef.current ?? base), ...patch }
        const remaining = getAppearanceDraftChanges(savedBase, next)
        draftRef.current = remaining
        setDraft(remaining)
        return Object.keys(remaining).length === 0
      })
      .catch((error: unknown) => {
        setSaveFailed(true)
        throw error
      })
      .finally(() => {
        savePromiseRef.current = null
        setSaving(false)
      })
    savePromiseRef.current = pending
    return pending
  }, [applyTheme, persistSettings])

  return {
    settings: effectiveSettings,
    changedKeys,
    hasChanges: changedKeys.length > 0,
    saving,
    saveFailed,
    stage,
    save,
    discard
  }
}
