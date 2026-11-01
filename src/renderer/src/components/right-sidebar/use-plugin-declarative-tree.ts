import { useEffect, useMemo, useRef, useState } from 'react'
import type { PluginDeclarativeNode } from '../../../../shared/plugins/declarative/plugin-declarative-catalog'
import { PLUGIN_DECLARATIVE_MESSAGES } from '../../../../shared/plugins/declarative/plugin-declarative-message-names'
import {
  parsePluginDeclarativeRender,
  pluginDeclarativeErrorPayloadSchema,
  pluginDeclarativeRenderIdentity,
  type PluginDeclarativeAckPayload
} from '../../../../shared/plugins/declarative/plugin-declarative-messages'
import { translate } from '@/i18n/i18n'
import type { PluginFrameDeclarativeChannel } from './plugin-frame-host'
import {
  createPluginDeclarativeGestureStability,
  PLUGIN_DECLARATIVE_SETTLE_MS
} from './plugin-declarative-gesture-stability'
import { createPluginDeclarativeGestureGeometry } from '@/components/plugins/declarative/plugin-declarative-gesture-geometry'
import type { PluginDeclarativePress } from '@/components/plugins/declarative/PluginDeclarativeControls'

/** How long a press on Orca's own controls lets the panel make one user-gesture call. */
export const PLUGIN_DECLARATIVE_PRESS_GRANT_MS = 1_000
/** Plugin error text shown in the banner; the full message is the plugin's own to log. */
export const PLUGIN_DECLARATIVE_ERROR_MAX_CHARS = 300
// Floor on the retry delay for a rate-limited render, so retries cannot spin.
const MIN_RENDER_RETRY_MS = 100

const systemNow = (): number => Date.now()

type RenderedTree = { document: string; revision: number; tree: PluginDeclarativeNode | null }
/**
 * `plugin`: text the plugin reported. `orca`: Orca refused what the plugin sent. `load`: the guest
 * failed before its first render (a broken dev save); any tree on screen is the last good one.
 */
export type PluginDeclarativeIssue = { source: 'plugin' | 'orca' | 'load'; message: string }

function invalidTreeMessage(): string {
  return translate(
    'auto.components.rightSidebar.PluginDeclarativePanel.invalidTree',
    'The panel sent a layout Orca cannot show.'
  )
}

function clamp(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim()
  return flat.length > PLUGIN_DECLARATIVE_ERROR_MAX_CHARS
    ? `${flat.slice(0, PLUGIN_DECLARATIVE_ERROR_MAX_CHARS - 1)}…`
    : flat
}

/**
 * A declarative panel's state on the host: the latest tree (parsed at most once per animation
 * frame, so a flood of renders costs one validation per frame), its issue banner, which controls
 * are settled enough to grant a gesture, and the one-shot grant a settled press gives. Every
 * parsed or refused render is acknowledged so the guest keeps resolving the tree on screen.
 */
export function usePluginDeclarativeTree(
  sendToGuest: (event: string, payload: unknown) => void,
  options: {
    /** Other guest `ui.*` messages (`ui.ready`, `ui.persist`), unvalidated. */
    onGuestEvent?: (event: string, payload: unknown) => void
    now?: () => number
  } = {}
) {
  const now = options.now ?? systemNow
  const [rendered, setRendered] = useState<RenderedTree | null>(null)
  const [issue, setIssue] = useState<PluginDeclarativeIssue | null>(null)
  // Bumps when a new guest document replaces one that had rendered here (a hot reload).
  const [reloads, setReloads] = useState(0)
  // True from a guest document's start until its first shown tree; errors then are load errors.
  const loadingRef = useRef(true)
  const lastDocumentRef = useRef<string | null>(null)
  const pendingRef = useRef<{ payload: unknown } | null>(null)
  const frameRef = useRef<number | null>(null)
  // The guest document on screen and its revision; a new document (reload) starts over at 1.
  const shownRef = useRef<{ document: string | null; revision: number }>({
    document: null,
    revision: -1
  })
  const pressedAtRef = useRef(Number.NEGATIVE_INFINITY)
  const warnedRef = useRef(new Set<string>())
  const sendRef = useRef(sendToGuest)
  const guestEventRef = useRef(options.onGuestEvent)
  useEffect(() => {
    sendRef.current = sendToGuest
    guestEventRef.current = options.onGuestEvent
  })
  const controls = useMemo(() => createPluginDeclarativeGestureStability(), [])
  const gestures = useMemo(() => createPluginDeclarativeGestureGeometry(now), [now])

  useEffect(
    () => () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
      }
    },
    []
  )

  const channel = useMemo<PluginFrameDeclarativeChannel>(() => {
    const ack = (payload: PluginDeclarativeAckPayload): void =>
      sendRef.current(PLUGIN_DECLARATIVE_MESSAGES.ack, payload)
    // Same text again stays the same object, so the live region does not announce it twice.
    const report = (next: PluginDeclarativeIssue): void =>
      setIssue((previous) =>
        previous?.source === next.source && previous.message === next.message ? previous : next
      )
    const flush = (): void => {
      frameRef.current = null
      const pending = pendingRef.current
      pendingRef.current = null
      if (!pending) {
        return
      }
      const parsed = parsePluginDeclarativeRender(pending.payload)
      if (!parsed.ok) {
        if (parsed.document !== null && parsed.revision !== null) {
          ack({ document: parsed.document, revision: parsed.revision, accepted: false })
        }
        console.warn(`[plugin] declarative render refused: ${parsed.error}`)
        report({ source: 'orca', message: invalidTreeMessage() })
        return
      }
      // Why: never step back to an older tree of the same document.
      const shown = shownRef.current
      if (parsed.document === shown.document && parsed.revision < shown.revision) {
        return
      }
      for (const warning of parsed.warnings) {
        if (!warnedRef.current.has(warning)) {
          warnedRef.current.add(warning)
          console.warn(`[plugin] ${warning}`)
        }
      }
      shownRef.current = { document: parsed.document, revision: parsed.revision }
      loadingRef.current = false
      if (lastDocumentRef.current !== null && lastDocumentRef.current !== parsed.document) {
        setReloads((count) => count + 1)
      }
      lastDocumentRef.current = parsed.document
      controls.observe(parsed.tree, now())
      setRendered({ document: parsed.document, revision: parsed.revision, tree: parsed.tree })
      setIssue(null)
      ack({ document: parsed.document, revision: parsed.revision, accepted: true })
    }
    return {
      onRender: (payload) => {
        pendingRef.current = { payload }
        frameRef.current ??= requestAnimationFrame(flush)
      },
      onRefused: (message, retryAfterMs) => {
        const payload: unknown =
          typeof message === 'object' && message !== null && 'payload' in message
            ? message.payload
            : undefined
        const identity = pluginDeclarativeRenderIdentity(payload)
        if (identity !== null) {
          ack(
            retryAfterMs === null
              ? { ...identity, accepted: false }
              : {
                  ...identity,
                  accepted: false,
                  retryAfterMs: Math.min(
                    60_000,
                    Math.max(MIN_RENDER_RETRY_MS, Math.ceil(retryAfterMs))
                  )
                }
          )
        }
        if (retryAfterMs === null) {
          report({ source: 'orca', message: invalidTreeMessage() })
        }
      },
      onGuestEvent: (event, payload) => guestEventRef.current?.(event, payload),
      onError: (payload) => {
        const parsed = pluginDeclarativeErrorPayloadSchema.safeParse(payload)
        report(
          parsed.success
            ? {
                source: loadingRef.current ? 'load' : 'plugin',
                message: clamp(parsed.data.message)
              }
            : { source: 'orca', message: invalidTreeMessage() }
        )
      }
    }
  }, [controls, now])

  const presses = useMemo(() => {
    // Stationary in the tree and on screen; measured right now, not at the last commit.
    const isSettled = (gestureId: string): boolean => {
      const at = now()
      gestures.sample(at)
      return (
        controls.isSettled(gestureId, at) &&
        gestures.isSettled(gestureId, at, PLUGIN_DECLARATIVE_SETTLE_MS)
      )
    }
    return {
      isSettled,
      /**
       * Judges a press on Orca's own control: false when it must not reach the guest at all (an
       * unsettled Link). A settled press that grants opens the one-shot gesture window.
       */
      admit: (press: PluginDeclarativePress): boolean => {
        const settled = isSettled(press.gestureId)
        if (settled && press.grants) {
          pressedAtRef.current = now()
        }
        return settled || press.control !== 'Link'
      },
      /** Stable: one user-gesture call per press, within the grant window. */
      consume: (): boolean => {
        const granted = now() - pressedAtRef.current < PLUGIN_DECLARATIVE_PRESS_GRANT_MS
        pressedAtRef.current = Number.NEGATIVE_INFINITY
        return granted
      },
      /** The guest navigated or reloaded: its fresh runtime counts revisions from 1 again. */
      resetDocument: (): void => {
        shownRef.current = { document: null, revision: -1 }
        loadingRef.current = true
        warnedRef.current.clear()
        pressedAtRef.current = Number.NEGATIVE_INFINITY
      }
    }
  }, [controls, gestures, now])

  return {
    rendered,
    issue,
    reloads,
    dismissIssue: () => setIssue(null),
    channel,
    gestures,
    admitPress: presses.admit,
    consumePress: presses.consume,
    isGestureSettled: presses.isSettled,
    resetDocument: presses.resetDocument
  }
}
