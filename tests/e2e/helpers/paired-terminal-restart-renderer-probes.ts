import type { Page } from '@stablyai/playwright-test'
import type { RuntimeMobileSessionTabsResult } from '../../../src/shared/runtime-types'
import { expect } from './orca-app'

export type PairedTerminalProbePhase = 'baseline' | 'restart' | 'close'

export type PairedTerminalBindingTransition = {
  binding: string | null
  bindings: [string, string][]
  layoutPresent: boolean
  phase: PairedTerminalProbePhase
  ptyIds: string[]
  stack: string | null
  tabPresent: boolean
  tabPtyId: string | null
}

export type PairedTerminalSnapshotReceipt = {
  leafId: string
  parentTabId: string
  publicationEpoch: string
  ptyId: string | null
  snapshotVersion: number
  status: 'pending-handle' | 'ready'
  terminal: string | null
  type: 'snapshot' | 'snapshots' | 'updated'
}

type BindingProbe = {
  capture: () => void
  lastKey: string
  phase: PairedTerminalProbePhase
  transitions: PairedTerminalBindingTransition[]
  unsubscribe: () => void
}

type SnapshotProbe = {
  errors: string[]
  receipts: PairedTerminalSnapshotReceipt[]
  unsubscribe: () => void
}

type ProbeWindow = typeof window & {
  __serveRestartBindingProbe?: BindingProbe
  __serveRestartSnapshotProbe?: SnapshotProbe
}

export async function installPairedTerminalSnapshotProbe(
  page: Page,
  environmentId: string,
  target: { leafId: string; parentTabId: string }
): Promise<void> {
  await page.evaluate(
    async ({ environmentId, target }) => {
      const probe: SnapshotProbe = { errors: [], receipts: [], unsubscribe: () => {} }
      const subscription = await window.api.runtimeEnvironments.subscribe(
        {
          selector: environmentId,
          method: 'session.tabs.subscribeAll',
          params: {},
          timeoutMs: 30_000
        },
        {
          onResponse: (response) => {
            if (!response.ok) {
              probe.errors.push(`${response.error.code}: ${response.error.message}`)
              return
            }
            const event = response.result as
              | ({ type: 'snapshot' | 'updated' } & RuntimeMobileSessionTabsResult)
              | { type: 'snapshots'; snapshots: RuntimeMobileSessionTabsResult[] }
            const snapshots = event.type === 'snapshots' ? event.snapshots : [event]
            for (const snapshot of snapshots) {
              const surface = snapshot.tabs.find(
                (tab) =>
                  tab.type === 'terminal' &&
                  tab.parentTabId === target.parentTabId &&
                  tab.leafId === target.leafId
              )
              if (surface?.type !== 'terminal') {
                continue
              }
              probe.receipts.push({
                leafId: surface.leafId,
                parentTabId: surface.parentTabId,
                publicationEpoch: snapshot.publicationEpoch,
                ptyId: surface.ptyId ?? null,
                snapshotVersion: snapshot.snapshotVersion,
                status: surface.status,
                terminal: surface.terminal,
                type: event.type
              })
            }
          },
          onError: (error) => probe.errors.push(`${error.code}: ${error.message}`)
        }
      )
      probe.unsubscribe = subscription.unsubscribe
      const probeWindow = window as ProbeWindow
      probeWindow.__serveRestartSnapshotProbe = probe
    },
    { environmentId, target }
  )
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as ProbeWindow).__serveRestartSnapshotProbe?.receipts.some(
              (receipt) => receipt.status === 'ready'
            ) ?? false
        ),
      { timeout: 30_000, message: 'Raw session-tab snapshot probe never received baseline state' }
    )
    .toBe(true)
}

export async function readPairedTerminalSnapshotProbe(
  page: Page
): Promise<{ errors: string[]; receipts: PairedTerminalSnapshotReceipt[] }> {
  return page.evaluate(() => {
    const probe = (window as ProbeWindow).__serveRestartSnapshotProbe
    if (!probe) {
      throw new Error('Serve-restart snapshot probe is unavailable')
    }
    return { errors: probe.errors, receipts: probe.receipts }
  })
}

export async function clearPairedTerminalSnapshotProbeErrors(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe = (window as ProbeWindow).__serveRestartSnapshotProbe
    if (!probe) {
      throw new Error('Serve-restart snapshot probe is unavailable')
    }
    probe.errors.length = 0
  })
}

export async function installPairedTerminalBindingProbe(
  page: Page,
  target: { leafId: string; webTabId: string; worktreeId: string }
): Promise<void> {
  await page.evaluate((target) => {
    const store = window.__store
    if (!store) {
      throw new Error('Paired-client store is unavailable')
    }
    const probe: BindingProbe = {
      capture: () => {},
      lastKey: '',
      phase: 'baseline',
      transitions: [],
      unsubscribe: () => {}
    }
    probe.capture = () => {
      const state = store.getState()
      const tab = (state.tabsByWorktree[target.worktreeId] ?? []).find(
        (candidate) => candidate.id === target.webTabId
      )
      const layout = state.terminalLayoutsByTabId[target.webTabId]
      const transition: PairedTerminalBindingTransition = {
        binding: layout?.ptyIdsByLeafId?.[target.leafId] ?? null,
        bindings: Object.entries(layout?.ptyIdsByLeafId ?? {}).sort(([left], [right]) =>
          left.localeCompare(right)
        ),
        layoutPresent: Boolean(layout),
        phase: probe.phase,
        ptyIds: [...(state.ptyIdsByTabId[target.webTabId] ?? [])],
        stack: new Error('renderer probe').stack ?? null,
        tabPresent: Boolean(tab),
        tabPtyId: tab?.ptyId ?? null
      }
      const key = JSON.stringify(transition)
      if (key !== probe.lastKey) {
        probe.lastKey = key
        probe.transitions.push(transition)
      }
    }
    probe.capture()
    probe.unsubscribe = store.subscribe(probe.capture)
    const probeWindow = window as ProbeWindow
    probeWindow.__serveRestartBindingProbe = probe
  }, target)
}

export async function setPairedTerminalProbePhase(
  page: Page,
  phase: PairedTerminalProbePhase
): Promise<void> {
  await page.evaluate((phase) => {
    const probe = (window as ProbeWindow).__serveRestartBindingProbe
    if (!probe) {
      throw new Error('Serve-restart binding probe is unavailable')
    }
    probe.phase = phase
    probe.capture()
  }, phase)
}

export async function readPairedTerminalBindingTransitions(
  page: Page
): Promise<PairedTerminalBindingTransition[]> {
  return page.evaluate(() => {
    const probe = (window as ProbeWindow).__serveRestartBindingProbe
    if (!probe) {
      throw new Error('Serve-restart binding probe is unavailable')
    }
    return probe.transitions
  })
}

export async function disposePairedTerminalRestartProbes(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const probeWindow = window as ProbeWindow
      probeWindow.__serveRestartBindingProbe?.unsubscribe()
      probeWindow.__serveRestartSnapshotProbe?.unsubscribe()
      delete probeWindow.__serveRestartBindingProbe
      delete probeWindow.__serveRestartSnapshotProbe
    })
    .catch(() => undefined)
}
