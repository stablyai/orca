import { getTerminalTab } from '@/store/terminals/ownership/terminal-tab-owner-index'
import { useAppStore } from '@/store/index'
import { waitForAgentDraftInputReady } from './agent-draft-readiness'

const pendingByTab = new Map<string, Set<() => void>>()
let stopClosedTabs: (() => void) | undefined

function cancelOnTabClose(tabId: string, cancel: () => void): () => void {
  const observers = pendingByTab.get(tabId) ?? new Set()
  observers.add(cancel)
  pendingByTab.set(tabId, observers)
  if (!stopClosedTabs) {
    let closed = useAppStore.getState().closedTerminalTabTombstonesByTabId
    stopClosedTabs = useAppStore.subscribe((state) => {
      if (closed === state.closedTerminalTabTombstonesByTabId) {
        return
      }
      closed = state.closedTerminalTabTombstonesByTabId
      for (const [id, callbacks] of pendingByTab) {
        if (closed?.[id]) {
          for (const callback of callbacks) {
            callback()
          }
        }
      }
    })
  }
  return () => {
    observers.delete(cancel)
    if (observers.size === 0) {
      pendingByTab.delete(tabId)
    }
    if (pendingByTab.size === 0) {
      stopClosedTabs?.()
      stopClosedTabs = undefined
    }
  }
}

export function waitForAgentDraftInputReadyOnTab(args: {
  tabId: string
  spawnTimeoutMs: number
  readinessTimeoutMs: number
  readySignal: Parameters<typeof waitForAgentDraftInputReady>[2]
  launchPty?: Promise<string | null>
}): Promise<{ ptyId: string; ready: boolean } | null> {
  return new Promise((resolve, reject) => {
    const readinessByPtyId = new Map<string, Promise<boolean>>()
    const observers = new Map<string, AbortController>()
    let selectedPtyId: string | null = null
    let seenTab = false
    let settled = false
    let spawnTimer: number | null = null
    let unsubscribeStore: (() => void) | null = null
    let stopCancellation: (() => void) | undefined
    const finish = (result: { ptyId: string; ready: boolean } | null, error?: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      if (spawnTimer !== null) {
        window.clearTimeout(spawnTimer)
      }
      unsubscribeStore?.()
      stopCancellation?.()
      for (const observer of observers.values()) {
        observer.abort()
      }
      observers.clear()
      if (error !== undefined) {
        reject(error)
      } else {
        resolve(result)
      }
    }
    const watchPty = (ptyId: string): Promise<boolean> => {
      const existing = readinessByPtyId.get(ptyId)
      if (existing) {
        return existing
      }
      const observer = new AbortController()
      observers.set(ptyId, observer)
      const readiness = waitForAgentDraftInputReady(
        ptyId,
        args.readinessTimeoutMs,
        args.readySignal,
        observer.signal
      )
      readinessByPtyId.set(ptyId, readiness)
      // Other panes can appear before the launch owner is selected; only that owner's failure is delivered.
      void readiness.catch(() => {})
      return readiness
    }
    const deliverPty = (ptyId: string): void => {
      if (settled) {
        return
      }
      selectedPtyId = ptyId
      for (const [candidate, observer] of observers) {
        if (candidate !== ptyId) {
          observer.abort()
          observers.delete(candidate)
          readinessByPtyId.delete(candidate)
        }
      }
      if (spawnTimer !== null) {
        window.clearTimeout(spawnTimer)
      }
      unsubscribeStore?.()
      void watchPty(ptyId).then(
        (ready) => finish({ ptyId, ready }),
        (error: unknown) => finish(null, error)
      )
    }
    const bindFromState = (state: ReturnType<typeof useAppStore.getState>): void => {
      const tab = getTerminalTab(state.tabsByWorktree ?? {}, args.tabId)
      if (seenTab && !tab) {
        finish(null)
        return
      }
      seenTab ||= Boolean(tab)
      if (selectedPtyId) {
        return
      }
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
      void args.launchPty.then(
        (ptyId) => (ptyId ? deliverPty(ptyId) : finish(null)),
        (error: unknown) => finish(null, error)
      )
    } else {
      spawnTimer = window.setTimeout(() => finish(null), args.spawnTimeoutMs)
    }
    stopCancellation = cancelOnTabClose(args.tabId, () => finish(null))
    unsubscribeStore = useAppStore.subscribe(bindFromState)
    bindFromState(useAppStore.getState())
  })
}
