import { useCallback, useState, type MutableRefObject } from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'

const saveFailed = (): string =>
  translate(
    'auto.components.settings.PluginsSettingsSection.settingsUpdateFailed',
    'Could not save plugin settings.'
  )

/** Plugin settings writes: the system switch and development folders re-discover; all report
 *  a failed save instead of dropping it. */
export function usePluginSettingsWrites({
  settings,
  updateSettings,
  mountedRef,
  rediscover,
  onStart
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
  mountedRef: MutableRefObject<boolean>
  rediscover: () => Promise<unknown>
  /** Clears list errors a new write supersedes. */
  onStart: () => void
}) {
  const [featureBusy, setFeatureBusy] = useState(false)
  const [devPathsBusy, setDevPathsBusy] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)

  const reset = useCallback(() => {
    setFeatureBusy(false)
    setDevPathsBusy(false)
    setSettingsError(null)
  }, [])

  const toggleFeature = async (): Promise<void> => {
    setFeatureBusy(true)
    setSettingsError(null)
    onStart()
    try {
      await updateSettings({ pluginSystemEnabled: !settings.pluginSystemEnabled })
      await rediscover()
    } catch {
      if (mountedRef.current) {
        setSettingsError(saveFailed())
      }
    } finally {
      if (mountedRef.current) {
        setFeatureBusy(false)
      }
    }
  }

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

  return {
    featureBusy,
    devPathsBusy,
    settingsError,
    reset,
    toggleFeature,
    toggleSuggestions,
    updateDevPaths
  }
}
