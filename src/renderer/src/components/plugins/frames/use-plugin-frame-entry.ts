import { useCallback, useEffect, useRef, useState } from 'react'
import type { PluginFrameGuest } from '../../../../../shared/plugins/frames/plugin-frame-bridge'
import { currentPluginFrameTheme } from './plugin-panel-design-token-css'
import { notePluginFrameIsolation } from '@/store/plugins/frames/plugin-frame-isolation'

/** Where a panel's plugin runs when its workspace is on a paired host: there, or here and why. */
export type PluginFrameHost = { kind: 'paired'; name: string } | { kind: 'local'; reason: string }

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
      host?: PluginFrameHost
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
  contributionId: string | null,
  /** A panel's focused workspace is on this paired host: its calls and pushes go there. */
  pairedEnvironmentId: string | null = null
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
    // The session token whose calls go to the paired host, and what the panel shows about it.
    let boundToken: string | null = null
    let host: PluginFrameHost | undefined
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
    const unbind = (): void => {
      if (boundToken) {
        void pluginsApi.unbindRemotePanel?.({ sessionToken: boundToken }).catch(() => undefined)
        boundToken = null
      }
    }
    // Binds before the frame mounts, so its first call already reaches the host.
    const bindHost = async (sessionToken: string | null): Promise<void> => {
      const bindRemotePanel = pluginsApi.bindRemotePanel
      if (surface !== 'panel' || !pairedEnvironmentId || !bindRemotePanel || !sessionToken) {
        return
      }
      if (boundToken === sessionToken) {
        return
      }
      unbind()
      const binding = await bindRemotePanel({
        sessionToken,
        environmentId: pairedEnvironmentId
      }).catch((error: unknown) => ({
        bound: false as const,
        reason: String(error)
      }))
      if (!binding.bound) {
        host = { kind: 'local', reason: binding.reason }
        return
      }
      if (cancelled) {
        void pluginsApi.unbindRemotePanel?.({ sessionToken }).catch(() => undefined)
        return
      }
      boundToken = sessionToken
      host = { kind: 'paired', name: binding.hostName }
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
        .then(async (result) => {
          if (cancelled || readId !== latestRead) {
            return
          }
          if (!result) {
            fail()
            return
          }
          await bindHost(result.sessionToken)
          if (cancelled || readId !== latestRead) {
            return
          }
          notePluginFrameIsolation(result.guest !== undefined)
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
            ...(result.ui === 'components' ? { ui: 'components' as const } : {}),
            ...(host ? { host } : {})
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
    // The host went away: draw the panel again, on the host if it is back, else here.
    const unsubscribeClosed = pluginsApi.onRemotePanelClosed?.((sessionToken) => {
      if (cancelled || sessionToken !== boundToken) {
        return
      }
      boundToken = null
      currentHtml = null
      setEntry({ status: 'loading' })
      load()
    })
    return () => {
      cancelled = true
      unsubscribe?.()
      unsubscribeClosed?.()
      unbind()
    }
  }, [surface, pluginKey, contributionId, pairedEnvironmentId])

  const markUnresponsive = useCallback(() => setEntry({ status: 'unresponsive' }), [])
  const remountGone = useCallback(() => remountRef.current(), [])
  return { entry, markUnresponsive, remountGone }
}
