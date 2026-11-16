import { inspectRuntimeTerminalProcess } from '@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection'
import type { DraftPasteReadySignal } from '../../../../../../shared/agent-launch/catalog/tui-agent-config-types'
import { subscribeToPtyData } from '@/components/terminal-pane/pty-transport/delivery/pty-data-sidecar-subscriptions'
import { replayPreHandlerPtyData } from '@/components/terminal-pane/pty-transport/delivery/pty-pre-handler-buffer'
import { isRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { subscribeToRuntimeTerminalData } from '@/runtime/hosted-terminals/streams/runtime-terminal-data-subscription'
import { createDraftPasteReadyScanner } from '../../../../../../shared/agent-launch/startup/readiness/draft-paste-ready-scanner'

const BRACKETED_PASTE_QUIET_MS = 1500

/** Observe without taking xterm’s primary handler; retain recent bytes because readiness markers can span chunks and the pane may attach mid-flight. */
export async function waitForAgentDraftInputReady(
  ptyId: string,
  timeoutMs: number,
  readySignal: DraftPasteReadySignal
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let setupReady = false
    let earlyData = ''
    let settled = false
    const scanner = createDraftPasteReadyScanner(readySignal)
    let quietTimer: number | null = null
    let graceTimer: number | null = null
    let hardTimer: number | null = null
    let unsubscribe: (() => void) | null = null

    const finish = (value: boolean, error?: unknown): void => {
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
      if (graceTimer !== null) {
        window.clearTimeout(graceTimer)
      }
      unsubscribe?.()
      if (error !== undefined) {
        reject(error)
      } else {
        resolve(value)
      }
    }

    const armQuietTimer = (): void => {
      if (quietTimer !== null) {
        window.clearTimeout(quietTimer)
      }
      quietTimer = window.setTimeout(() => finish(true), BRACKETED_PASTE_QUIET_MS)
    }

    const observeData = (data: string): void => {
      if (settled) {
        return
      }
      if (!setupReady) {
        earlyData = (earlyData + data).slice(-64 * 1024)
        return
      }
      const { ready, armQuietTimer: shouldArm, readyAfterMs } = scanner.observe(data)
      if (ready) {
        finish(true)
        return
      }
      if (readyAfterMs === null && graceTimer !== null) {
        window.clearTimeout(graceTimer)
        graceTimer = null
      } else if (typeof readyAfterMs === 'number' && graceTimer === null) {
        graceTimer = window.setTimeout(() => finish(true), readyAfterMs)
      }
      if (shouldArm) {
        armQuietTimer()
      }
    }

    if (isRemoteRuntimePtyId(ptyId)) {
      void subscribeToRuntimeTerminalData(ptyId, `desktop:paste-ready:${ptyId}`, observeData)
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
      // Replay early buffered Codex output to this observer without consuming xterm’s primary copy.
      replayPreHandlerPtyData(ptyId, observeData)
    }

    void inspectRuntimeTerminalProcess(ptyId, { waitForSetup: true })
      .then(() => {
        if (settled) {
          return
        }
        setupReady = true
        const data = earlyData
        earlyData = ''
        observeData(data)
        if (!settled) {
          hardTimer = window.setTimeout(() => finish(graceTimer !== null), timeoutMs)
        }
      })
      .catch((error: unknown) => finish(false, error))
  })
}
