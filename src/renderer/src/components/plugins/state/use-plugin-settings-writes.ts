import { isPluginAutoUpdateOn } from '../../../../../shared/plugins/catalog/plugin-update-policy'
import { useCallback, useState, type MutableRefObject } from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'

const saveFailed = (): string =>
  translate(
    'auto.components.settings.PluginsSettingsSection.settingsUpdateFailed',
    'Could not save plugin settings.'
  )

/** Plugin settings writes: development folders re-discover; all report a failed save
 *  instead of dropping it. */
export function usePluginSettingsWrites({
  settings,
  updateSettings,
  mountedRef,
  rediscover
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
  mountedRef: MutableRefObject<boolean>
  rediscover: () => Promise<unknown>
}) {
  const [devPathsBusy, setDevPathsBusy] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)

  const reset = useCallback(() => {
    setDevPathsBusy(false)
    setSettingsError(null)
  }, [])

  const updateDevPaths = async (paths: string[]): Promise<void> => {
    setDevPathsBusy(true)
    setSettingsError(null)
    try {
      await updateSettings({ devPluginPaths: paths })
      await rediscover()
    } catch {
      const message = saveFailed()
      if (mountedRef.current) {
        setSettingsError(message)
      }
      throw new Error(message)
    } finally {
      if (mountedRef.current) {
        setDevPathsBusy(false)
      }
    }
  }

  const toggleSuggestions = async (): Promise<void> => {
    setSettingsError(null)
    try {
      await updateSettings({
        pluginFileTypeSuggestions: settings.pluginFileTypeSuggestions === false
      })
    } catch {
      if (mountedRef.current) {
        setSettingsError(saveFailed())
      }
    }
  }

  const toggleAutoUpdate = async (): Promise<void> => {
    setSettingsError(null)
    try {
      await updateSettings({
        pluginUpdatePolicy: isPluginAutoUpdateOn(settings) ? 'manual' : 'auto'
      })
    } catch {
      if (mountedRef.current) {
        setSettingsError(saveFailed())
      }
    }
  }

  return {
    devPathsBusy,
    settingsError,
    reset,
    toggleSuggestions,
    toggleAutoUpdate,
    updateDevPaths
  }
}
