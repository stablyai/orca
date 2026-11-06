import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { WslDistroHoldState } from '../../../../shared/wsl-distro-stopped-hold'

type HeldPane = {
  distro: string
  /** What the running read said: a stop, or no answer. */
  state: WslDistroHoldState
  /** Reconnects as the user's act, which may start the distro. */
  release: () => Promise<unknown>
}

/** Restored WSL bridge panes held because their distro was stopped and no user act asked for them. */
export const wslDistroStoppedHoldStore = createStore<{ panes: Record<string, HeldPane> }>(() => ({
  panes: {}
}))

/** Registers a held pane; the returned teardown forgets it if it unmounts while held. */
export function holdPaneForStoppedWslDistro(paneKey: string, pane: HeldPane): () => void {
  wslDistroStoppedHoldStore.setState(({ panes }) => ({ panes: { ...panes, [paneKey]: pane } }))
  return () => forgetHeldPane(paneKey, pane.release)
}

function forgetHeldPane(paneKey: string, release: HeldPane['release']): void {
  wslDistroStoppedHoldStore.setState(({ panes }) => {
    if (panes[paneKey]?.release !== release) {
      return {}
    }
    const { [paneKey]: _forgotten, ...rest } = panes
    return { panes: rest }
  })
}

/** Start: every pane held for this distro reconnects; the first spawn starts the distro. */
export function startHeldPanesForWslDistro(distro: string): void {
  const held = Object.entries(wslDistroStoppedHoldStore.getState().panes).filter(
    ([, pane]) => pane.distro.toLowerCase() === distro.toLowerCase()
  )
  for (const [paneKey, pane] of held) {
    forgetHeldPane(paneKey, pane.release)
    void pane.release()
  }
}

/** The distro this pane is held for and what its read said, or null. */
export function useWslDistroStoppedHold(
  paneKey: string
): { distro: string; state: WslDistroHoldState } | null {
  const distro = useStore(wslDistroStoppedHoldStore, (store) => store.panes[paneKey]?.distro)
  const state = useStore(wslDistroStoppedHoldStore, (store) => store.panes[paneKey]?.state)
  return distro && state ? { distro, state } : null
}
