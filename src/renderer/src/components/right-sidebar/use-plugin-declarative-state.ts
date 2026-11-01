import { useEffect, useRef, useState } from 'react'
import { PLUGIN_DECLARATIVE_MESSAGES } from '../../../../shared/plugins/declarative/plugin-declarative-message-names'
import {
  pluginDeclarativePersistPayloadSchema,
  pluginDeclarativeReadyPayloadSchema,
  type PluginDeclarativeHydratePayload,
  type PluginDeclarativeStoredValue
} from '../../../../shared/plugins/declarative/plugin-declarative-messages'
import type { PluginPanelStateSnapshot } from '../../../../shared/plugins/declarative/plugin-declarative-panel-state'
import { useAppStore } from '@/store'
import { createPluginDeclarativeRetainedMemory } from './plugin-declarative-retained-memory'

type SendToGuest = (event: string, payload: unknown) => void

async function readState(
  sessionToken: string | null,
  workspace: string | null
): Promise<PluginPanelStateSnapshot | null> {
  const panelState = window.api?.plugins?.panelState
  if (!sessionToken || !panelState) {
    return null
  }
  const result = await panelState({ op: 'read', sessionToken, workspace }).catch(() => null)
  return result?.ok && result.state ? result.state : null
}

/**
 * A components panel's context and persisted atoms: answers the guest's `ui.ready` with
 * `ui.hydrate` (panel id, visibility, stored values), stores its `ui.persist` writes, re-hydrates
 * workspace atoms when the active workspace changes, and reports visibility changes. With
 * `hotReload` (dev folders), it also keeps the guest's keyed memory atoms (`ui.retain`) in memory
 * and seeds the next guest of a dev save with them.
 */
export function usePluginDeclarativeState(options: {
  panelId: string
  sessionToken: string | null
  visible: boolean
  sendToGuest: SendToGuest
  hotReload?: boolean
}): { onGuestEvent: (event: string, payload: unknown) => void } {
  const { panelId, sessionToken, visible, sendToGuest } = options
  const hotReload = options.hotReload === true
  const workspace = useAppStore((state) => state.activeWorktreeId)
  const [retained] = useState(createPluginDeclarativeRetainedMemory)
  // The document already seeded: a workspace re-hydrate must not roll its memory atoms back.
  const seededRef = useRef<string | null>(null)
  // The document that asked to hydrate; workspace switches re-hydrate only that guest.
  const [readyDocument, setReadyDocument] = useState<string | null>(null)
  const latest = useRef({ panelId, sessionToken, visible, workspace, sendToGuest })
  useEffect(() => {
    latest.current = { panelId, sessionToken, visible, workspace, sendToGuest }
  })

  useEffect(() => {
    if (!readyDocument) {
      return
    }
    let cancelled = false
    void readState(latest.current.sessionToken, workspace).then((state) => {
      if (cancelled) {
        return
      }
      const memory: Record<string, PluginDeclarativeStoredValue> | null =
        hotReload && seededRef.current !== readyDocument ? retained.snapshot() : null
      seededRef.current = readyDocument
      const payload: PluginDeclarativeHydratePayload = {
        panel: { id: latest.current.panelId },
        visible: latest.current.visible,
        ...(state ? { plugin: state.plugin, workspace: state.workspace } : {}),
        ...(memory ? { memory } : {}),
        ...(hotReload ? { retain: true as const } : {})
      }
      latest.current.sendToGuest(PLUGIN_DECLARATIVE_MESSAGES.hydrate, payload)
    })
    return () => {
      cancelled = true
    }
  }, [hotReload, readyDocument, retained, workspace])

  useEffect(() => {
    if (readyDocument) {
      latest.current.sendToGuest(PLUGIN_DECLARATIVE_MESSAGES.visibility, { visible })
    }
  }, [readyDocument, visible])

  return {
    onGuestEvent: (event, payload) => {
      if (event === PLUGIN_DECLARATIVE_MESSAGES.ready) {
        const ready = pluginDeclarativeReadyPayloadSchema.safeParse(payload)
        if (ready.success) {
          setReadyDocument(ready.data.document)
        }
        return
      }
      if (event === PLUGIN_DECLARATIVE_MESSAGES.retain) {
        if (hotReload) {
          retained.accept(payload)
        }
        return
      }
      if (event === PLUGIN_DECLARATIVE_MESSAGES.persist) {
        const persist = pluginDeclarativePersistPayloadSchema.safeParse(payload)
        const panelState = window.api?.plugins?.panelState
        const token = latest.current.sessionToken
        if (persist.success && panelState && token) {
          void panelState({
            op: 'write',
            sessionToken: token,
            workspace: latest.current.workspace,
            entries: persist.data.entries
          }).catch(() => undefined)
        }
      }
    }
  }
}
