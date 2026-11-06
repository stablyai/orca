import { useCallback, useEffect, useState } from 'react'
import type { PluginDeclaredSettingsSnapshot } from '../../../../../shared/plugins/contributions/plugin-settings-values'
import type { PluginJsonValue } from '../../../../../shared/plugins/workers/plugin-host-api'

export type PluginDeclaredSettingsState = {
  snapshot: PluginDeclaredSettingsSnapshot | null
  /** Why the last edit of each key was refused, until it next succeeds. */
  errors: Readonly<Record<string, string>>
  write: (key: string, value: PluginJsonValue) => void
}

/** A plugin's `contributes.settings` and their values, re-read when `revision` changes. */
export function usePluginDeclaredSettings(
  pluginKey: string,
  revision: string
): PluginDeclaredSettingsState {
  const [snapshot, setSnapshot] = useState<PluginDeclaredSettingsSnapshot | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const load = useCallback(async (): Promise<PluginDeclaredSettingsSnapshot | null> => {
    const read = window.api?.plugins?.getSettings
    return read ? read({ pluginKey }).catch(() => null) : null
  }, [pluginKey])

  useEffect(() => {
    let current = true
    void load().then((next) => current && setSnapshot(next))
    return () => {
      current = false
    }
  }, [load, revision])

  const write = useCallback(
    (key: string, value: PluginJsonValue): void => {
      const setSetting = window.api?.plugins?.setSetting
      if (!setSetting) {
        return
      }
      void setSetting({ pluginKey, key, value })
        .then(async (result) => {
          setErrors(({ [key]: _previous, ...rest }) =>
            result.ok ? rest : { ...rest, [key]: result.error }
          )
          if (result.ok) {
            setSnapshot(await load())
          }
        })
        .catch((error: unknown) => setErrors((previous) => ({ ...previous, [key]: String(error) })))
    },
    [load, pluginKey]
  )

  return { snapshot, errors, write }
}
