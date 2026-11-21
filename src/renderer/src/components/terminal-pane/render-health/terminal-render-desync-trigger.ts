import { forEachLivePaneForDesyncSentinel } from '@/lib/pane-manager/pane-manager-registry'
import {
  captureRenderDesyncNow,
  startRenderDesyncSampleBurst,
  stopRenderDesyncSampleBurst
} from './terminal-render-desync-sentinel'

/** Opt-in Cmd/Ctrl+click samples divergence for 10s; add Shift for immediate capture without detection/recovery. Enable through localStorage or the live hidden-experimental toggle. */
export const RENDER_DESYNC_SENTINEL_FLAG = 'orca:render-desync-sentinel'

type SentinelPane = {
  terminal: unknown
}

let clickListener: ((event: MouseEvent) => void) | null = null
let sessionArmedOverride: boolean | null = null

export function maybeStartTerminalRenderDesyncSentinel(): void {
  if (!isTerminalRenderDesyncSentinelArmed()) {
    return
  }
  installClickListener()
}

function installClickListener(): void {
  if (clickListener != null) {
    return
  }
  clickListener = (event) => {
    const isMac = navigator.userAgent.includes('Mac')
    if (event.button !== 0 || (isMac ? !event.metaKey : !event.ctrlKey)) {
      return
    }
    const target = event.target
    if (!(target instanceof Node)) {
      return
    }
    let clickedPaneKey: string | null = null
    let clickedPane: unknown = null
    forEachLivePaneForDesyncSentinel((paneKey, pane) => {
      const terminal = (pane as SentinelPane).terminal as { element?: HTMLElement }
      if (terminal.element?.contains(target)) {
        clickedPaneKey = paneKey
        clickedPane = pane
      }
    })
    if (!clickedPane || clickedPaneKey == null) {
      return
    }
    if (event.shiftKey) {
      captureRenderDesyncNow(clickedPaneKey, clickedPane)
      return
    }
    startRenderDesyncSampleBurst((clickedPane as SentinelPane).terminal)
  }
  document.addEventListener('mouseup', clickListener, true)
  console.warn('[terminal] render-desync sentinel armed (10s post-link bursts + ⇧-capture)')
}

export function isTerminalRenderDesyncSentinelArmed(): boolean {
  if (sessionArmedOverride != null) {
    return sessionArmedOverride
  }
  try {
    return globalThis.localStorage?.getItem(RENDER_DESYNC_SENTINEL_FLAG) === '1'
  } catch {
    return false
  }
}

/** Persist and toggle capture gestures live; content-free weight/reveal probes remain always on independently. */
export function setTerminalRenderDesyncSentinelArmed(armed: boolean): void {
  try {
    const storage = globalThis.localStorage
    if (!storage) {
      sessionArmedOverride = armed
    } else if (armed) {
      storage.setItem(RENDER_DESYNC_SENTINEL_FLAG, '1')
      sessionArmedOverride = null
    } else {
      storage.removeItem(RENDER_DESYNC_SENTINEL_FLAG)
      sessionArmedOverride = null
    }
  } catch {
    sessionArmedOverride = armed
  }
  if (armed) {
    installClickListener()
  } else {
    removeClickListener()
    stopRenderDesyncSampleBurst()
  }
}

export function stopTerminalRenderDesyncTriggerForTesting(): void {
  removeClickListener()
}

function removeClickListener(): void {
  if (clickListener != null) {
    document.removeEventListener('mouseup', clickListener, true)
    clickListener = null
  }
}

if (import.meta !== undefined && import.meta.hot) {
  // Dispose stale gesture closures on Vite replacement without requiring a full reload.
  import.meta.hot.dispose(() => {
    removeClickListener()
    stopRenderDesyncSampleBurst()
  })
}
