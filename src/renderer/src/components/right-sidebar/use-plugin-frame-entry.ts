import { useCallback, useEffect, useState } from 'react'

export type PluginFrameEntryState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'unresponsive' }
  | { status: 'ready'; html: string; sessionToken: string | null; revision: number }

/**
 * A plugin frame's document (panel or custom editor), reread on every plugin change. Only new
 * HTML bumps the revision that remounts the frame; a suspended frame stays suspended until then.
 */
export function usePluginFrameEntry(
  surface: 'panel' | 'editor',
  /** Null while there is no plugin to read from. */
  pluginKey: string | null,
  /** The panel or custom editor id in the plugin's manifest. */
  contributionId: string | null
): { entry: PluginFrameEntryState; markUnresponsive: () => void } {
  const [entry, setEntry] = useState<PluginFrameEntryState>({ status: 'loading' })

  useEffect(() => {
    if (!pluginKey || !contributionId) {
      return
    }
    let cancelled = false
    let currentHtml: string | null = null
    let revision = 0
    // Why: refresh events start overlapping reads; only the newest may set the entry.
    let latestRead = 0
    setEntry({ status: 'loading' })
    const pluginsApi = window.api?.plugins
    if (!pluginsApi) {
      setEntry({ status: 'error' })
      return
    }
    const fail = (): void => {
      currentHtml = null
      setEntry({ status: 'error' })
    }
    const load = (): void => {
      const readId = ++latestRead
      const pending =
        surface === 'panel'
          ? pluginsApi.readPanelEntry({ pluginKey, panelId: contributionId })
          : pluginsApi.readCustomEditorEntry?.({ pluginKey, editorId: contributionId })
      if (!pending) {
        fail()
        return
      }
      pending
        .then((result) => {
          if (cancelled || readId !== latestRead) {
            return
          }
          if (!result) {
            fail()
            return
          }
          const changed = result.html !== currentHtml
          if (changed) {
            currentHtml = result.html
            revision += 1
          }
          const ready: PluginFrameEntryState = {
            status: 'ready',
            html: result.html,
            sessionToken: result.sessionToken,
            revision
          }
          // Why: a session rotation must not revive a frame the watchdog suspended.
          setEntry((previous) =>
            previous.status === 'unresponsive' && !changed ? previous : ready
          )
        })
        .catch(() => {
          if (!cancelled && readId === latestRead) {
            fail()
          }
        })
    }
    load()
    const unsubscribe = pluginsApi.onChanged ? pluginsApi.onChanged(load) : null
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [surface, pluginKey, contributionId])

  const markUnresponsive = useCallback(() => setEntry({ status: 'unresponsive' }), [])
  return { entry, markUnresponsive }
}
