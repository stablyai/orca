import type { ElectronApplication, Page } from '@stablyai/playwright-test'

const DEFAULT_STATUS_UPDATE_INTERVAL_MS = 100
const IPC_SETTLE_TIMEOUT_MS = 10_000
const STAGGERED_VALIDATION_DELAY_MS = 40
const SYNTHETIC_TAB_PREFIX = 'synthetic-tab-'

type SyntheticStatusPane = {
  paneKey: string
  prompt?: string
  agentType?: string
  stateStartedAt: number
  tabId?: string
  worktreeId?: string
}

type StatusReceipt = { paneKey: string; receivedAt: number }

export type AccumulatedStatusTrafficStats = {
  trackedStatuses: number
  generatedUpdates: number
  acceptedUpdates: number
  statusPublications: number
  completedRounds: number
  latestReceipts: number
}

export type AccumulatedStatusIngressValidation = {
  burstEvents: number
  staggeredEvents: number
}

type AccumulatedStatusTrafficRun = {
  completedRounds: number
  generatedUpdates: number
  lastReceivedAtByPaneKey: Record<string, number>
}

/** The Electron main-process global the traffic generator parks its controller on. */
type StatusTrafficHost = typeof globalThis & {
  __orcaAccumulatedStatusTrafficController?: { stop: () => AccumulatedStatusTrafficRun }
}

type StatusTrafficWindow = Window & {
  __accumulatedStatusTrafficProbe?: {
    baselineSequenceByPaneKey: Record<string, number>
    statusPublications: number
    unsubscribe: () => void
  }
}

async function syntheticStatusPanes(page: Page): Promise<SyntheticStatusPane[]> {
  return page.evaluate((syntheticTabPrefix) => {
    const statuses = window.__store?.getState().agentStatusByPaneKey ?? {}
    return Object.values(statuses)
      .filter(({ paneKey }) => paneKey.startsWith(syntheticTabPrefix))
      .map((entry) => ({
        paneKey: entry.paneKey,
        prompt: entry.prompt,
        agentType: entry.agentType,
        stateStartedAt: entry.stateStartedAt,
        tabId: entry.tabId,
        worktreeId: entry.worktreeId
      }))
  }, SYNTHETIC_TAB_PREFIX)
}

async function waitForStatusReceipts(
  page: Page,
  receipts: readonly StatusReceipt[]
): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const statuses = window.__store?.getState().agentStatusByPaneKey ?? {}
      return expected.every(
        ({ paneKey, receivedAt }) => statuses[paneKey]?.updatedAt === receivedAt
      )
    },
    receipts,
    { timeout: IPC_SETTLE_TIMEOUT_MS }
  )
}

/** Proves the real IPC bridge routes both same-tick bursts and arrivals spanning its window. */
export async function validateAccumulatedStatusIpcIngress(
  electronApp: ElectronApplication,
  page: Page
): Promise<AccumulatedStatusIngressValidation> {
  const panes = (await syntheticStatusPanes(page)).slice(0, 3)
  if (panes.length === 0) {
    return { burstEvents: 0, staggeredEvents: 0 }
  }
  const burstReceipts = await electronApp.evaluate(
    ({ BrowserWindow }, validationPanes): StatusReceipt[] => {
      const appWindow = BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed() && !candidate.webContents.isDestroyed()
      )
      if (!appWindow) {
        throw new Error('Orca BrowserWindow is unavailable')
      }
      const receivedAt = Date.now()
      return validationPanes.map((pane) => {
        appWindow.webContents.send('agentStatus:set', {
          ...pane,
          state: 'working',
          receivedAt
        })
        return { paneKey: pane.paneKey, receivedAt }
      })
    },
    panes
  )
  await waitForStatusReceipts(page, burstReceipts)

  const staggeredReceipts = await electronApp.evaluate(
    async ({ BrowserWindow }, { delayMs, validationPanes }): Promise<StatusReceipt[]> => {
      const appWindow = BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed() && !candidate.webContents.isDestroyed()
      )
      if (!appWindow) {
        throw new Error('Orca BrowserWindow is unavailable')
      }
      const receipts: StatusReceipt[] = []
      for (const pane of validationPanes) {
        const receivedAt = Date.now()
        appWindow.webContents.send('agentStatus:set', {
          ...pane,
          state: 'working',
          receivedAt
        })
        receipts.push({ paneKey: pane.paneKey, receivedAt })
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      return receipts
    },
    { delayMs: STAGGERED_VALIDATION_DELAY_MS, validationPanes: panes }
  )
  await waitForStatusReceipts(page, staggeredReceipts)
  return { burstEvents: burstReceipts.length, staggeredEvents: staggeredReceipts.length }
}

/** Emits recurring same-tick bursts through Electron IPC; the production bridge owns batching. */
export async function startAccumulatedStatusTraffic(
  electronApp: ElectronApplication,
  page: Page,
  intervalMs = DEFAULT_STATUS_UPDATE_INTERVAL_MS
): Promise<{ trackedStatuses: number }> {
  const panes = await syntheticStatusPanes(page)
  await page.evaluate(
    (paneKeys) => {
      const store = window.__store
      if (!store) {
        throw new Error('store unavailable')
      }
      const baselineSequenceByPaneKey = Object.fromEntries(
        paneKeys.map((paneKey) => [
          paneKey,
          store.getState().agentStatusByPaneKey[paneKey]?.acceptedStatusSeq ?? 0
        ])
      )
      const target: StatusTrafficWindow = window
      const probe = {
        baselineSequenceByPaneKey,
        statusPublications: 0,
        unsubscribe: () => {}
      }
      target.__accumulatedStatusTrafficProbe = probe
      probe.unsubscribe = store.subscribe((next, previous) => {
        if (next.agentStatusByPaneKey !== previous.agentStatusByPaneKey) {
          const activeProbe = target.__accumulatedStatusTrafficProbe
          if (activeProbe) {
            activeProbe.statusPublications += 1
          }
        }
      })
    },
    panes.map(({ paneKey }) => paneKey)
  )

  await electronApp.evaluate(
    ({ BrowserWindow }, { intervalMs, panes }) => {
      const appWindow = BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed() && !candidate.webContents.isDestroyed()
      )
      if (!appWindow) {
        throw new Error('Orca BrowserWindow is unavailable')
      }
      const host: StatusTrafficHost = globalThis
      if (host.__orcaAccumulatedStatusTrafficController) {
        throw new Error('accumulated status traffic is already running')
      }
      let completedRounds = 0
      let generatedUpdates = 0
      let previousRoundReceivedAt = Date.now()
      const lastReceivedAtByPaneKey: Record<string, number> = {}
      const timer = setInterval(
        () => {
          const receivedAt = Math.max(Date.now(), previousRoundReceivedAt + 1)
          previousRoundReceivedAt = receivedAt
          for (const pane of panes) {
            appWindow.webContents.send('agentStatus:set', {
              ...pane,
              state: 'working',
              receivedAt
            })
            lastReceivedAtByPaneKey[pane.paneKey] = receivedAt
            generatedUpdates += 1
          }
          completedRounds += 1
        },
        Math.max(10, Math.floor(intervalMs))
      )
      host.__orcaAccumulatedStatusTrafficController = {
        stop: () => {
          clearInterval(timer)
          delete host.__orcaAccumulatedStatusTrafficController
          return { completedRounds, generatedUpdates, lastReceivedAtByPaneKey }
        }
      }
    },
    { intervalMs, panes }
  )
  return { trackedStatuses: panes.length }
}

export async function stopAccumulatedStatusTraffic(
  electronApp: ElectronApplication,
  page: Page
): Promise<AccumulatedStatusTrafficStats> {
  const mainStats = await electronApp.evaluate((): AccumulatedStatusTrafficRun | null => {
    const host: StatusTrafficHost = globalThis
    return host.__orcaAccumulatedStatusTrafficController?.stop() ?? null
  })
  if (!mainStats) {
    await page.evaluate(() => {
      const target: StatusTrafficWindow = window
      target.__accumulatedStatusTrafficProbe?.unsubscribe()
      delete target.__accumulatedStatusTrafficProbe
    })
    return {
      trackedStatuses: 0,
      generatedUpdates: 0,
      acceptedUpdates: 0,
      statusPublications: 0,
      completedRounds: 0,
      latestReceipts: 0
    }
  }
  const receipts = Object.entries(mainStats.lastReceivedAtByPaneKey).map(
    ([paneKey, receivedAt]) => ({ paneKey, receivedAt })
  )
  await waitForStatusReceipts(page, receipts)
  return page.evaluate(({ completedRounds, generatedUpdates, lastReceivedAtByPaneKey }) => {
    const state = window.__store?.getState()
    const target: StatusTrafficWindow = window
    const probe = target.__accumulatedStatusTrafficProbe
    if (!state || !probe) {
      throw new Error('accumulated status traffic evidence is unavailable')
    }
    let acceptedUpdates = 0
    let latestReceipts = 0
    for (const [paneKey, baselineSequence] of Object.entries(probe.baselineSequenceByPaneKey)) {
      const entry = state.agentStatusByPaneKey[paneKey]
      acceptedUpdates += (entry?.acceptedStatusSeq ?? baselineSequence) - baselineSequence
      if (entry?.updatedAt === lastReceivedAtByPaneKey[paneKey]) {
        latestReceipts += 1
      }
    }
    probe.unsubscribe()
    delete target.__accumulatedStatusTrafficProbe
    return {
      trackedStatuses: Object.keys(probe.baselineSequenceByPaneKey).length,
      generatedUpdates,
      acceptedUpdates,
      statusPublications: probe.statusPublications,
      completedRounds,
      latestReceipts
    }
  }, mainStats)
}
