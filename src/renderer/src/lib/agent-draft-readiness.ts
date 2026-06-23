import type { DraftPasteReadySignal } from '../../../shared/tui-agent-config'
import type { GlobalSettings } from '../../../shared/types'
import { subscribeToPtyData } from '@/components/terminal-pane/pty-data-sidecar-subscriptions'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { subscribeToRuntimeTerminalData } from '@/runtime/runtime-terminal-stream'

const DECSET_BRACKETED_PASTE = '\x1b[?2004h'
const CODEX_COMPOSER_PROMPT = '›'
const BRACKETED_PASTE_QUIET_MS = 1500

/**
 * Tap the PTY data stream as a side-channel observer (does NOT take over
 * the primary handler that feeds xterm) and resolve once input is ready.
 *
 * Why a sidecar subscription:
 *   - the main pane may attach mid-flight; we must not race against its
 *     handler registration on the dispatcher's primary slot.
 *   - DECSET 2004 and the Codex composer prompt may straddle two data chunks,
 *     so keep a small ring of recent bytes and search the union.
 */
export function waitForAgentDraftInputReady(
  ptyId: string,
  timeoutMs: number,
  readySignal: DraftPasteReadySignal,
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    let recent = ''
    let postHandshakeRecent = ''
    let saw2004 = false
    let quietTimer: number | null = null
    let hardTimer: number | null = null
    let unsubscribe: (() => void) | null = null

    const finish = (value: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      if (hardTimer !== null) {
        window.clearTimeout(hardTimer)
      }
      if (quietTimer !== null) {
        window.clearTimeout(quietTimer)
      }
      unsubscribe?.()
      resolve(value)
    }

    const armQuietTimer = (): void => {
      if (quietTimer !== null) {
        window.clearTimeout(quietTimer)
      }
      quietTimer = window.setTimeout(() => finish(true), BRACKETED_PASTE_QUIET_MS)
    }

    const observeData = (data: string): void => {
      // Why: 512 bytes covers split escape sequences and Codex's styled prompt
      // without retaining a large terminal scrollback copy.
      const combined = recent + data
      recent = combined.slice(-512)
      if (!saw2004) {
        const markerIndex = combined.indexOf(DECSET_BRACKETED_PASTE)
        if (markerIndex === -1) {
          return
        }
        saw2004 = true
        const postHandshakeChunk = combined.slice(markerIndex + DECSET_BRACKETED_PASTE.length)
        if (readySignal === 'codex-composer-prompt') {
          if (postHandshakeChunk.includes(CODEX_COMPOSER_PROMPT)) {
            finish(true)
            return
          }
          postHandshakeRecent = postHandshakeChunk.slice(-512)
          return
        }
        postHandshakeRecent = postHandshakeChunk.slice(-512)
      } else {
        if (
          readySignal === 'codex-composer-prompt' &&
          (data.includes(CODEX_COMPOSER_PROMPT) ||
            (postHandshakeRecent + data).includes(CODEX_COMPOSER_PROMPT))
        ) {
          finish(true)
          return
        }
        postHandshakeRecent = (postHandshakeRecent + data).slice(-512)
      }
      if (readySignal === 'codex-composer-prompt') {
        return
      }
      if (saw2004) {
        armQuietTimer()
      }
    }

    if (isRemoteRuntimePtyId(ptyId)) {
      void subscribeToRuntimeTerminalData(
        settings,
        ptyId,
        `desktop:paste-ready:${ptyId}`,
        observeData
      )
        .then((remoteUnsubscribe) => {
          if (settled) {
            remoteUnsubscribe()
            return
          }
          unsubscribe = remoteUnsubscribe
        })
        .catch(() => finish(false))
    } else {
      unsubscribe = subscribeToPtyData(ptyId, observeData)
    }

    if (!settled) {
      hardTimer = window.setTimeout(() => finish(false), timeoutMs)
    }
  })
}
