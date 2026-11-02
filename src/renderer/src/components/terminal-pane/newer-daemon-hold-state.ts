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
  release: () => Promise<HeldPaneReopenOutcome>
}

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
  pane: Omit<HeldPane, 'phase' | 'dismissed'>
): () => void {
  newerDaemonHoldStore.setState(({ panes }) => ({
    panes: { ...panes, [paneKey]: { ...pane, phase: 'held', dismissed: false } }
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
  const heldCount = useStore(newerDaemonHoldStore, (state) => Object.keys(state.panes).length)
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
      count: reopened
    }),
    resumed > 0
      ? {
          description: translate(
            'terminal.newerDaemonBanner.resumed',
            '{{count}} agent sessions resumed.',
            { count: resumed }
          )
        }
      : undefined
  )
}

/** Stops the newer daemon, then lets every held pane through its normal restore path. */
export async function reopenHeldTerminals(): Promise<void> {
  const { panes } = newerDaemonHoldStore.getState()
  const attempt = Object.keys(panes)
  if (Object.values(panes).some((pane) => pane.phase === 'reopening')) {
    return
  }
  updatePanes(attempt, { phase: 'reopening' })
  const reopened = await window.api.pty.reopenNewerDaemonTerminals().then(
    (result) => result.reopened,
    () => false
  )
  if (!reopened) {
    updatePanes(attempt, { phase: 'failed' })
    return
  }
  const released = Object.values(newerDaemonHoldStore.getState().panes)
  newerDaemonHoldStore.setState({ panes: {} })
  const outcomes = await Promise.all(
    released.map((pane) =>
      pane.release().catch((): HeldPaneReopenOutcome => ({ reopened: false, agentResumed: false }))
    )
  )
  announceReopenedTerminals(outcomes)
}
