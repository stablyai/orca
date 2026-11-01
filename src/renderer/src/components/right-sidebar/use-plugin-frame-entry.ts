import { useCallback, useEffect, useRef, useState } from 'react'
import type { PluginFrameGuest } from '../../../../shared/plugins/frames/plugin-frame-bridge'
import { currentPluginFrameTheme } from './plugin-panel-design-token-css'

export type PluginFrameEntryState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'unresponsive' }
  | {
      status: 'ready'
      html: string
      sessionToken: string | null
      revision: number
      guest?: PluginFrameGuest
      ui?: 'components'
    }

/**
 * A plugin frame's document (panel or custom editor), reread on every plugin change. Only new
 * HTML bumps the revision that remounts the frame; a suspended frame stays suspended until then.
 */
const GUEST_REMOUNT_LIMIT = 3
const GUEST_REMOUNT_WINDOW_MS = 60_000

export function usePluginFrameEntry(
  surface: 'panel' | 'editor',
  /** Null while there is no plugin to read from. */
  pluginKey: string | null,
  /** The panel or custom editor id in the plugin's manifest. */
  contributionId: string | null
): { entry: PluginFrameEntryState; markUnresponsive: () => void; remountGone: () => void } {
  const [entry, setEntry] = useState<PluginFrameEntryState>({ status: 'loading' })
  const remountRef = useRef<() => void>(() => {})

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
      // Main bakes this into an isolated guest's document so its first paint already matches.
      const theme = currentPluginFrameTheme()
      const pending =
        surface === 'panel'
          ? pluginsApi.readPanelEntry({ pluginKey, panelId: contributionId, theme })
          : pluginsApi.readCustomEditorEntry?.({ pluginKey, editorId: contributionId, theme })
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
          // Why the guest URL too: it is the document a guest loads, so a new one must remount.
          const identity = `${result.guest?.url ?? ''}\0${result.html}`
          const changed = identity !== currentHtml
          if (changed) {
            currentHtml = identity
            revision += 1
          }
          const ready: PluginFrameEntryState = {
            status: 'ready',
            html: result.html,
            sessionToken: result.sessionToken,
            revision,
            ...(result.guest ? { guest: result.guest } : {}),
            ...(result.ui === 'components' ? { ui: 'components' as const } : {})
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
    // A guest main closed (revoked, crashed) at an unchanged URL would stay blank: re-read the
    // entry and force a new document; a few tries, then the error state.
    const goneAt: number[] = []
    remountRef.current = () => {
      const now = Date.now()
      while (goneAt.length > 0 && (goneAt[0] ?? now) <= now - GUEST_REMOUNT_WINDOW_MS) {
        goneAt.shift()
      }
      goneAt.push(now)
      if (goneAt.length > GUEST_REMOUNT_LIMIT) {
        fail()
        return
      }
      currentHtml = null
      load()
    }
    const unsubscribe = pluginsApi.onChanged ? pluginsApi.onChanged(load) : null
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [surface, pluginKey, contributionId])

  const markUnresponsive = useCallback(() => setEntry({ status: 'unresponsive' }), [])
  const remountGone = useCallback(() => remountRef.current(), [])
  return { entry, markUnresponsive, remountGone }
}
