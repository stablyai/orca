import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/** What one held pane did once released through the normal restore path. */
export type HeldPaneReopenOutcome = { reopened: boolean; agentResumed: boolean }

export type NewerDaemonHoldPhase = 'held' | 'reopening' | 'failed'

type HeldPane = {
  /** The cold-restore resume test passed when the pane was held. */
  resumable: boolean
  // Why a phase per pane: a pane held after a failed attempt has not failed anything yet.
  phase: NewerDaemonHoldPhase
  /** Banner hidden for this app session; the pane stays held. */
  dismissed: boolean
  /** Whose newer build holds it: this machine, or a paired server (its environment id). */
  host: string
  /** A local pane's restore; a server's pane has none, since the server's frames release it. */
  release?: () => Promise<HeldPaneReopenOutcome>
}

const LOCAL_HOLD_HOST = 'local'

/** How each host's Reopen stops its newer build; true once its held panes may start. */
const hostReopens = new Map<string, () => Promise<boolean>>([
  [
    LOCAL_HOLD_HOST,
    () =>
      window.api.pty.reopenNewerDaemonTerminals().then(
        (result) => result.reopened,
        () => false
      )
  ]
])

export const newerDaemonHoldStore = createStore<{ panes: Record<string, HeldPane> }>(() => ({
  panes: {}
}))

function updatePanes(paneKeys: readonly string[], update: Partial<HeldPane>): void {
  newerDaemonHoldStore.setState(({ panes }) => ({
    panes: Object.fromEntries(
      Object.entries(panes).map(([key, pane]) => [
        key,
        paneKeys.includes(key) ? { ...pane, ...update } : pane
      ])
    )
  }))
}

export function dismissHeldPaneBanner(paneKey: string): void {
  updatePanes([paneKey], { dismissed: true })
}

// Why batched: a restore burst holds many panes, and each write re-renders every shown banner's count.
const HOLD_REGISTRATION_BATCH_MS = 16
const pendingHolds = new Map<string, HeldPane>()
let pendingHoldsFlush: ReturnType<typeof setTimeout> | null = null

function flushPendingHolds(): void {
  if (pendingHoldsFlush !== null) {
    clearTimeout(pendingHoldsFlush)
    pendingHoldsFlush = null
  }
  if (pendingHolds.size === 0) {
    return
  }
  const added = Object.fromEntries(pendingHolds)
  pendingHolds.clear()
  newerDaemonHoldStore.setState(({ panes }) => ({ panes: { ...panes, ...added } }))
}

/** The hold host of a pane a paired server refused; it has no Reopen unless that server's frames give one. */
export function serverHoldHost(environmentId: string): string {
  return `server:${environmentId}`
}

/** Registers a held pane; the returned teardown forgets it if it unmounts while held. */
export function holdPaneForNewerDaemon(
  paneKey: string,
  pane: { resumable: boolean; release?: () => Promise<HeldPaneReopenOutcome> },
  host: string = LOCAL_HOLD_HOST
): () => void {
  const held: HeldPane = { ...pane, host, phase: 'held', dismissed: false }
  if (newerDaemonHoldStore.getState().panes[paneKey]) {
    // A pane held again in place swaps its banner in one write, so it never blinks out.
    pendingHolds.delete(paneKey)
    newerDaemonHoldStore.setState(({ panes }) => ({ panes: { ...panes, [paneKey]: held } }))
  } else {
    pendingHolds.set(paneKey, held)
    pendingHoldsFlush ??= setTimeout(flushPendingHolds, HOLD_REGISTRATION_BATCH_MS)
  }
  return () => {
    const pending = pendingHolds.get(paneKey)
    if (pending?.host === host && pending.release === pane.release) {
      pendingHolds.delete(paneKey)
      return
    }
    const shown = newerDaemonHoldStore.getState().panes[paneKey]
    // A stale teardown (its pane already released or re-held) must not publish a write.
    if (shown?.host !== host || shown.release !== pane.release) {
      return
    }
    newerDaemonHoldStore.setState(({ panes }) => {
      const { [paneKey]: _forgotten, ...rest } = panes
      return { panes: rest }
    })
  }
}

// Keyed by the panes record itself, so a replaced record and its pane callbacks are never kept alive.
const heldCountsByPanes = new WeakMap<Record<string, HeldPane>, Map<string, number>>()

/** Held panes per host, counted once per store write rather than once per banner. */
function heldCountOnHost(panes: Record<string, HeldPane>, host: string): number {
  let byHost = heldCountsByPanes.get(panes)
  if (!byHost) {
    byHost = new Map<string, number>()
    for (const held of Object.values(panes)) {
      byHost.set(held.host, (byHost.get(held.host) ?? 0) + 1)
    }
    heldCountsByPanes.set(panes, byHost)
  }
  return byHost.get(host) ?? 0
}

/** This pane's banner state, null when not held or dismissed; heldCount is every pane one Reopen releases. */
export function useNewerDaemonHold(paneKey: string): {
  resumable: boolean
  phase: NewerDaemonHoldPhase
  heldCount: number
  canReopen: boolean
} | null {
  const pane = useStore(newerDaemonHoldStore, (state) => state.panes[paneKey])
  // Why gated: a Retry-only banner shows no count, so it must not re-render as other panes are held.
  const heldCount = useStore(newerDaemonHoldStore, (state) =>
    pane && hostReopens.has(pane.host) ? heldCountOnHost(state.panes, pane.host) : 0
  )
  return pane && !pane.dismissed
    ? {
        resumable: pane.resumable,
        phase: pane.phase,
        heldCount,
        canReopen: hostReopens.has(pane.host)
      }
    : null
}

export function announceReopenedTerminals(outcomes: readonly HeldPaneReopenOutcome[]): void {
  const reopened = outcomes.filter((outcome) => outcome.reopened).length
  if (reopened === 0) {
    return
  }
  const resumed = outcomes.filter((outcome) => outcome.reopened && outcome.agentResumed).length
  toast.success(
    translate('terminal.newerDaemonBanner.reopened', 'Reopened {{count}} terminals', {
      count: reopened,
      defaultValue_one: 'Reopened {{count}} terminal'
    }),
    resumed > 0
      ? {
          description: translate(
            'terminal.newerDaemonBanner.resumed',
            '{{count}} agent sessions resumed.',
            { count: resumed, defaultValue_one: '{{count}} agent session resumed.' }
          )
        }
      : undefined
  )
}

/** Reconcile server-held panes from its frames, preserving phases for ongoing holds; reopen targets that server. */
export function showServerHeldPanes(
  environmentId: string,
  paneKeys: readonly string[],
  reopen: () => Promise<boolean>
): void {
  const host = serverHoldHost(environmentId)
  if (paneKeys.length === 0) {
    hostReopens.delete(host)
  } else {
    hostReopens.set(host, reopen)
  }
  const { panes: current } = newerDaemonHoldStore.getState()
  const shown = Object.keys(current).filter((key) => current[key]?.host === host)
  if (shown.length === paneKeys.length && paneKeys.every((key) => shown.includes(key))) {
    return
  }
  newerDaemonHoldStore.setState(({ panes }) => {
    const next = Object.fromEntries(Object.entries(panes).filter(([, pane]) => pane.host !== host))
    for (const key of paneKeys) {
      // A pane still held keeps its phase; one this machine holds keeps its own hold.
      next[key] ??= panes[key] ?? { resumable: false, phase: 'held', dismissed: false, host }
    }
    return { panes: next }
  })
}

/** Starts one held pane again where its host's newer build can't be stopped from here. */
export async function retryHeldPane(paneKey: string): Promise<void> {
  flushPendingHolds()
  const pane = newerDaemonHoldStore.getState().panes[paneKey]
  if (!pane?.release || pane.phase === 'reopening') {
    return
  }
  // Why the pane stays shown: its release forgets it once the retry settles, so a refusal never flickers.
  updatePanes([paneKey], { phase: 'reopening' })
  await pane.release().catch(() => updatePanes([paneKey], { phase: 'held' }))
  flushPendingHolds()
}

/** Stops the newer build holding this pane, then lets each of that host's held panes start. */
export async function reopenHeldTerminals(paneKey: string): Promise<void> {
  flushPendingHolds()
  const { panes } = newerDaemonHoldStore.getState()
  // Never fall back to this machine’s service when a server-owned pane disappears.
  const host = panes[paneKey]?.host
  if (host === undefined) {
    return
  }
  const attempt = Object.entries(panes).filter(([, pane]) => pane.host === host)
  const reopen = hostReopens.get(host)
  if (!reopen || attempt.some(([, pane]) => pane.phase === 'reopening')) {
    return
  }
  const attemptKeys = attempt.map(([key]) => key)
  updatePanes(attemptKeys, { phase: 'reopening' })
  const reopened = await reopen().catch(() => false)
  if (!reopened) {
    updatePanes(attemptKeys, { phase: 'failed' })
    return
  }
  // A pane refused while the stop ran is still batched; it is released with the rest.
  flushPendingHolds()
  // A server's panes stay Reopening until its frames stop holding them.
  if (host !== LOCAL_HOLD_HOST) {
    return
  }
  const current = newerDaemonHoldStore.getState().panes
  const releases = Object.values(current).flatMap((pane) =>
    pane.host === LOCAL_HOLD_HOST && pane.release ? [pane.release] : []
  )
  newerDaemonHoldStore.setState({
    panes: Object.fromEntries(
      Object.entries(current).filter(([, pane]) => pane.host !== LOCAL_HOLD_HOST)
    )
  })
  const outcomes = await Promise.all(
    releases.map((release) =>
      release().catch((): HeldPaneReopenOutcome => ({ reopened: false, agentResumed: false }))
    )
  )
  announceReopenedTerminals(outcomes)
}
