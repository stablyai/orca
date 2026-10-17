import type { GlobalSettings } from '../../../shared/global-settings-types'
import { isExpectedAgentProcess } from '../../../shared/agent-process-recognition'
import { useAppStore } from '@/store'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import { waitForAgentDraftInputReady } from './agent-draft-readiness'

export function waitForAgentDraftInputReadyOnTab(args: {
  tabId: string
  spawnTimeoutMs: number
  readinessTimeoutMs: number
  readySignal: Parameters<typeof waitForAgentDraftInputReady>[2]
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
}): Promise<{ ptyId: string; ready: boolean } | null> {
  return new Promise((resolve) => {
    let selectedPtyId: string | null = null
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
    const bindPty = (ptyId: string): void => {
      if (selectedPtyId || settled) {
        return
      }
      selectedPtyId = ptyId
      if (spawnTimer !== null) {
        window.clearTimeout(spawnTimer)
      }
      unsubscribeStore?.()
      // Why: Zustand subscribers run inside updateTabPtyId, before the transport drain.
      void waitForAgentDraftInputReady(
        ptyId,
        args.readinessTimeoutMs,
        args.readySignal,
        args.settings
      ).then((ready) => finish({ ptyId, ready }))
    }
    const bindFromState = (state: ReturnType<typeof useAppStore.getState>): void => {
      const ptyId = state.ptyIdsByTabId[args.tabId]?.[0]
      if (ptyId) {
        bindPty(ptyId)
      }
    }

    spawnTimer = window.setTimeout(() => finish(null), args.spawnTimeoutMs)
    unsubscribeStore = useAppStore.subscribe(bindFromState)
    bindFromState(useAppStore.getState())
  })
}

export async function waitForExpectedAgentOnPty(
  ptyId: string,
  expectedProcess: string,
  timeoutMs: number,
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const process = await withDeadline(
        inspectRuntimeTerminalProcess(settings, ptyId),
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
