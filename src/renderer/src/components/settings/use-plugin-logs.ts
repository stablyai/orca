import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { PluginHostListEntry, PluginHostLogLine } from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import type { PluginLogsState } from './PluginSettingsRow'

export function usePluginLogs(
  mounted: boolean,
  mountedRef: MutableRefObject<boolean>,
  plugins: readonly PluginHostListEntry[]
): {
  openLogs: ReadonlySet<string>
  logsByPlugin: Readonly<Record<string, PluginLogsState>>
  toggleLogs: (pluginKey: string) => void
} {
  const [openLogs, setOpenLogs] = useState<Set<string>>(() => new Set())
  const [logsByPlugin, setLogsByPlugin] = useState<Record<string, PluginLogsState>>({})
  const nextRequestRef = useRef(0)
  const requestsRef = useRef<Record<string, number>>({})

  useEffect(() => {
    if (!mounted) {
      setOpenLogs(new Set())
      setLogsByPlugin({})
      requestsRef.current = {}
      return
    }
    const installedKeys = new Set(plugins.map((plugin) => plugin.pluginKey))
    setOpenLogs(
      (current) => new Set([...current].filter((pluginKey) => installedKeys.has(pluginKey)))
    )
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

  const toggleLogs = (pluginKey: string): void => {
    if (openLogs.has(pluginKey)) {
      setOpenLogs((current) => {
        const next = new Set(current)
        next.delete(pluginKey)
        return next
      })
      return
    }
    setOpenLogs((current) => new Set(current).add(pluginKey))
    if (logsByPlugin[pluginKey]?.lines) {
      return
    }
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

  return { openLogs, logsByPlugin, toggleLogs }
}
