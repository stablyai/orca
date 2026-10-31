import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { PluginHostListEntry, PluginHostLogLine } from '../../../../../preload/api-types'
import { translate } from '@/i18n/i18n'

export type PluginLogsState = {
  loading: boolean
  lines?: PluginHostLogLine[]
  error?: string
}

export function usePluginLogs(
  mounted: boolean,
  mountedRef: MutableRefObject<boolean>,
  plugins: readonly PluginHostListEntry[]
): {
  logsByPlugin: Readonly<Record<string, PluginLogsState>>
  showLogs: (pluginKey: string) => void
} {
  const [logsByPlugin, setLogsByPlugin] = useState<Record<string, PluginLogsState>>({})
  const nextRequestRef = useRef(0)
  const requestsRef = useRef<Record<string, number>>({})

  useEffect(() => {
    if (!mounted) {
      setLogsByPlugin({})
      requestsRef.current = {}
      return
    }
    const installedKeys = new Set(plugins.map((plugin) => plugin.pluginKey))
    setLogsByPlugin((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([pluginKey]) => installedKeys.has(pluginKey))
      )
    )
    for (const pluginKey of Object.keys(requestsRef.current)) {
      if (!installedKeys.has(pluginKey)) {
        delete requestsRef.current[pluginKey]
      }
    }
  }, [mounted, plugins])

  /** Re-reads a plugin's logs; a plugin page always shows the latest. */
  const showLogs = (pluginKey: string): void => {
    const requestId = ++nextRequestRef.current
    requestsRef.current[pluginKey] = requestId
    setLogsByPlugin((current) => ({ ...current, [pluginKey]: { loading: true } }))
    void window.api.plugins
      .getLogs({ pluginKey })
      .then((lines: PluginHostLogLine[]) => {
        if (mountedRef.current && requestsRef.current[pluginKey] === requestId) {
          setLogsByPlugin((current) => ({
            ...current,
            [pluginKey]: { loading: false, lines }
          }))
        }
      })
      .catch((cause: unknown) => {
        console.warn('[plugins] log request failed:', cause)
        if (mountedRef.current && requestsRef.current[pluginKey] === requestId) {
          setLogsByPlugin((current) => ({
            ...current,
            [pluginKey]: {
              loading: false,
              error: translate(
                'auto.components.settings.PluginsSettingsSection.logsFailed',
                'Could not load plugin logs.'
              )
            }
          }))
        }
      })
  }

  return { logsByPlugin, showLogs }
}
