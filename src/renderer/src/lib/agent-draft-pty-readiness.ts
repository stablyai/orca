import { isExpectedAgentProcess } from '../../../shared/agent-process-recognition'
import { useAppStore } from '@/store'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import { waitForAgentDraftInputReady } from './agent-draft-readiness'

export function waitForAgentDraftInputReadyOnTab(args: {
  tabId: string
  spawnTimeoutMs: number
  readinessTimeoutMs: number
  readySignal: Parameters<typeof waitForAgentDraftInputReady>[2]
  launchPty?: Promise<string | null>
}): Promise<{ ptyId: string; ready: boolean } | null> {
  return new Promise((resolve) => {
    const readinessByPtyId = new Map<string, Promise<boolean>>()
    let settled = false
    let spawnTimer: number | null = null
    let unsubscribeStore: (() => void) | null = null
    const finish = (result: { ptyId: string; ready: boolean } | null): void => {
      if (settled) {
        return
      }
      settled = true
      if (spawnTimer !== null) {
        window.clearTimeout(spawnTimer)
      }
      unsubscribeStore?.()
      resolve(result)
    }
    const watchPty = (ptyId: string): Promise<boolean> => {
      const existing = readinessByPtyId.get(ptyId)
      if (existing) {
        return existing
      }
      const readiness = waitForAgentDraftInputReady(
        ptyId,
        args.readinessTimeoutMs,
        args.readySignal
      )
      readinessByPtyId.set(ptyId, readiness)
      return readiness
    }
    const deliverPty = (ptyId: string): void => {
      if (settled) {
        return
      }
      if (spawnTimer !== null) {
        window.clearTimeout(spawnTimer)
      }
      unsubscribeStore?.()
      void watchPty(ptyId).then((ready) => finish({ ptyId, ready }))
    }
    const bindFromState = (state: ReturnType<typeof useAppStore.getState>): void => {
      const ptyIds = state.ptyIdsByTabId[args.tabId] ?? []
      if (args.launchPty) {
        // Each pane's readiness attaches before its primary handler drains startup bytes.
        for (const ptyId of ptyIds) {
          watchPty(ptyId)
        }
      } else if (ptyIds[0]) {
        deliverPty(ptyIds[0])
      }
    }
    if (args.launchPty) {
      void args.launchPty.then((ptyId) => (ptyId ? deliverPty(ptyId) : finish(null)))
    } else {
      spawnTimer = window.setTimeout(() => finish(null), args.spawnTimeoutMs)
    }
    unsubscribeStore = useAppStore.subscribe(bindFromState)
    bindFromState(useAppStore.getState())
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
