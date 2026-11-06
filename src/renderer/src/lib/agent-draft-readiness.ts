import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import { isExpectedAgentProcess } from '../../../shared/agent-status/process/agent-process-recognition'
import type { DraftPasteReadySignal } from '../../../shared/agent-launch/catalog/tui-agent-config-types'
import { subscribeToPtyData } from '@/components/terminal-pane/pty-data-sidecar-subscriptions'
import { replayPreHandlerPtyData } from '@/components/terminal-pane/pty-pre-handler-buffer'
import { isRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import { subscribeToRuntimeTerminalData } from '@/runtime/runtime-terminal-stream'
import { createDraftPasteReadyScanner } from '../../../shared/draft-paste-ready-scanner'

const BRACKETED_PASTE_QUIET_MS = 1500

/** Observe without taking xterm’s primary handler; retain recent bytes because readiness markers can span chunks and the pane may attach mid-flight. */
export function waitForAgentDraftInputReady(
  ptyId: string,
  timeoutMs: number,
  readySignal: DraftPasteReadySignal
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const scanner = createDraftPasteReadyScanner(readySignal)
    let quietTimer: number | null = null
    let graceTimer: number | null = null
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
      if (graceTimer !== null) {
        window.clearTimeout(graceTimer)
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

    if (!settled) {
      // A pending grace means the box was seen: take it, as the box rule would have.
      hardTimer = window.setTimeout(() => finish(graceTimer !== null), timeoutMs)
    }
  })
}

export async function waitForExpectedAgentOnPty(
  ptyId: string,
  expectedProcess: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const process = await withDeadline(
        inspectRuntimeTerminalProcess(ptyId),
        Math.max(0, deadline - Date.now())
      )
      if (!process) {
        return false
      }
      const foreground = process.foregroundProcess?.toLowerCase() ?? ''
      if (isExpectedAgentProcess(foreground, expectedProcess)) {
        return true
      }
    } catch {
      // Ignore transient PTY inspection failures and keep polling.
    }
    const delayMs = Math.min(120, Math.max(0, deadline - Date.now()))
    if (delayMs > 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs))
    }
  }
  return false
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  if (timeoutMs <= 0) {
    return Promise.resolve(null)
  }
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => resolve(null), timeoutMs)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timer)
        reject(error)
      }
    )
  })
}
