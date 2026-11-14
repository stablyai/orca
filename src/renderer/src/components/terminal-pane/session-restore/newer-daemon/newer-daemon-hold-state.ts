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

/** Registers a held pane; the returned teardown forgets it if it unmounts while held. */
export function holdPaneForNewerDaemon(
  paneKey: string,
  pane: { resumable: boolean; release: () => Promise<HeldPaneReopenOutcome> }
): () => void {
  newerDaemonHoldStore.setState(({ panes }) => ({
    panes: {
      ...panes,
      [paneKey]: { ...pane, host: LOCAL_HOLD_HOST, phase: 'held', dismissed: false }
    }
  }))
  return () =>
    newerDaemonHoldStore.setState(({ panes }) => {
      if (panes[paneKey]?.release !== pane.release) {
        return {}
      }
      const { [paneKey]: _forgotten, ...rest } = panes
      return { panes: rest }
    })
}

/** This pane's banner state, null when not held or dismissed; heldCount is every pane one Reopen releases. */
export function useNewerDaemonHold(
  paneKey: string
): { resumable: boolean; phase: NewerDaemonHoldPhase; heldCount: number } | null {
  const pane = useStore(newerDaemonHoldStore, (state) => state.panes[paneKey])
  const heldCount = useStore(
    newerDaemonHoldStore,
    (state) => Object.values(state.panes).filter((held) => held.host === pane?.host).length
  )
  return pane && !pane.dismissed
    ? { resumable: pane.resumable, phase: pane.phase, heldCount }
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
  const host = `server:${environmentId}`
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

/** Stops the newer build holding this pane, then lets each of that host's held panes start. */
export async function reopenHeldTerminals(paneKey: string): Promise<void> {
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
