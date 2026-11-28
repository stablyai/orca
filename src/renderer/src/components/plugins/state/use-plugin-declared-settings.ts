import { useCallback, useEffect, useRef, useState } from 'react'
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
  revision: string,
  settingsRevision = 0
): PluginDeclaredSettingsState {
  const [snapshot, setSnapshot] = useState<PluginDeclaredSettingsSnapshot | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const activePlugin = useRef<symbol | null>(null)
  const latestRead = useRef(0)

  const load = useCallback(async (): Promise<PluginDeclaredSettingsSnapshot | null> => {
    const read = window.api?.plugins?.getSettings
    return read ? read({ pluginKey }).catch(() => null) : null
  }, [pluginKey])

  useEffect(() => {
    const current = Symbol(pluginKey)
    activePlugin.current = current
    setSnapshot(null)
    setErrors({})
    return () => {
      if (activePlugin.current === current) {
        activePlugin.current = null
        latestRead.current += 1
      }
    }
  }, [pluginKey])

  const refresh = useCallback(async (): Promise<void> => {
    const current = activePlugin.current
    const read = ++latestRead.current
    const next = await load()
    if (current && current === activePlugin.current && read === latestRead.current) {
      setSnapshot(next)
    }
  }, [load])

  useEffect(() => {
    void refresh()
  }, [refresh, revision, settingsRevision])

  const write = useCallback(
    (key: string, value: PluginJsonValue): void => {
      const setSetting = window.api?.plugins?.setSetting
      const current = activePlugin.current
      if (!setSetting || !current) {
        return
      }
      void setSetting({ pluginKey, key, value })
        .then(async (result) => {
          if (current !== activePlugin.current) {
            return
          }
          setErrors(({ [key]: _previous, ...rest }) =>
            result.ok ? rest : { ...rest, [key]: result.error }
          )
          if (result.ok) {
            await refresh()
          }
        })
        .catch((error: unknown) => {
          if (current === activePlugin.current) {
            setErrors((previous) => ({ ...previous, [key]: String(error) }))
          }
        })
    },
    [pluginKey, refresh]
  )

  return { snapshot, errors, write }
}
