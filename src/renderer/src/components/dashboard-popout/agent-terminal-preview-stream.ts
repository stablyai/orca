import { Unicode11Addon } from '@xterm/addon-unicode11'
import type { Terminal } from '@xterm/xterm'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import type {
  TerminalPreviewConnectResult,
  TerminalPreviewDataPayload
} from '../../../../shared/terminal-preview'
import { activateOrcaTerminalUnicodeProvider } from '../../../../shared/terminal-unicode-provider'
import { syncPreviewTerminalLigatures } from './preview-terminal-ligatures'
import { replayPreviewConnectionSnapshot } from './preview-terminal-snapshot-replay'
import type { TerminalPreviewLivePayload } from './agent-terminal-preview-scheduling'

export {
  connectAgentTerminalPreview,
  createAgentTerminalPreviewResizeScheduler,
  createPassiveAgentTerminalLiveQueue,
  retainAgentTerminalPreviewConnection,
  scheduleAgentTerminalPreviewFrameTask,
  type TerminalPreviewLivePayload
} from './agent-terminal-preview-scheduling'

type TerminalPreviewStreamListener = (payload: TerminalPreviewDataPayload) => void | Promise<void>

const listenersByPtyId = new Map<string, Set<TerminalPreviewStreamListener>>()
let disposeGlobalListener: (() => void) | null = null

export function createAgentTerminalPreviewFitScheduler(args: {
  container: HTMLElement
  getTerminal: () => Terminal | null
}): { schedule: () => void; dispose: () => void } {
  let frame: number | null = null
  let disposed = false
  const fit = (): void => {
    const terminal = args.getTerminal()
    const screen = args.container.querySelector<HTMLElement>('.xterm-screen')
    const box = args.container.parentElement
    if (!screen || !box || !terminal) {
      return
    }
    const scale = Math.min(
      1,
      box.clientWidth / Math.max(1, screen.offsetWidth),
      box.clientHeight / Math.max(1, screen.offsetHeight)
    )
    args.container.style.transform = scale < 1 ? `scale(${scale})` : ''
    const cellHeight = screen.offsetHeight / Math.max(1, terminal.rows)
    const cursorBottom = (terminal.buffer.active.cursorY + 1) * cellHeight * scale
    const anchorTop = cursorBottom <= box.clientHeight
    box.style.alignItems = anchorTop ? 'flex-start' : 'flex-end'
    args.container.style.transformOrigin = anchorTop ? 'top left' : 'bottom left'
  }
  const schedule = (): void => {
    if (frame !== null || disposed) {
      return
    }
    frame = requestAnimationFrame(() => {
      frame = null
      if (!disposed) {
        fit()
      }
    })
  }
  return {
    schedule,
    dispose: () => {
      disposed = true
      if (frame !== null) {
        cancelAnimationFrame(frame)
        frame = null
      }
    }
  }
}

export function preparePassiveAgentTerminalOutput(
  terminal: Terminal,
  settings: GlobalSettings | null
): void {
  terminal.loadAddon(new Unicode11Addon())
  activateOrcaTerminalUnicodeProvider(terminal)
  syncPreviewTerminalLigatures(terminal, settings)
  terminal.textarea?.setAttribute('tabindex', '-1')
}

export function createAgentTerminalPreviewWriter(args: {
  getTerminal: () => Terminal | null
  isDisposed: () => boolean
  onParsedWrite: () => void
}): {
  kittyKeyboardModes: TerminalKittyKeyboardModeTracker
  isReplaying: () => boolean
  replay: (connection: TerminalPreviewConnectResult) => void
  releasePending: () => void
  writeBarrier: (onDone: () => void) => void
  writeLive: (payload: TerminalPreviewLivePayload) => Promise<void>
} {
  const kittyKeyboardModes = new TerminalKittyKeyboardModeTracker()
  const pendingLivePayloads: {
    payload: TerminalPreviewLivePayload
    resolve: () => void
  }[] = []
  let replayDepth = 0
  const write = (chunk: string, onDone?: () => void, live = false): void => {
    if (live) {
      kittyKeyboardModes.scan(chunk)
    } else {
      kittyKeyboardModes.scanReplay(chunk)
    }
    replayDepth++
    args.getTerminal()?.write(chunk, () => {
      replayDepth--
      args.onParsedWrite()
      onDone?.()
    })
  }
  const writeLive = (payload: TerminalPreviewLivePayload): Promise<void> =>
    new Promise<void>((resolve) => {
      if (args.isDisposed()) {
        resolve()
        return
      }
      if (!args.getTerminal()) {
        pendingLivePayloads.push({ payload, resolve })
        return
      }
      write(payload.data, resolve, true)
    })
  return {
    kittyKeyboardModes,
    isReplaying: () => replayDepth > 0,
    replay: (connection) => {
      replayPreviewConnectionSnapshot({
        snapshot: connection.snapshot!,
        replay: connection.replay,
        kittyKeyboardModes,
        write: (chunk, live) => write(chunk, undefined, live)
      })
      for (const pending of pendingLivePayloads.splice(0)) {
        write(pending.payload.data, pending.resolve, true)
      }
    },
    releasePending: () => {
      for (const pending of pendingLivePayloads.splice(0)) {
        pending.resolve()
      }
    },
    writeBarrier: (onDone) => write('', onDone),
    writeLive
  }
}

function dispatchTerminalPreviewPayload(payload: TerminalPreviewDataPayload): void {
  const listeners = listenersByPtyId.get(payload.ptyId)
  if (!listeners) {
    if (payload.type === 'data') {
      void window.api.terminalPreview.ack(payload.ptyId, payload.bytes)
    }
    return
  }
  const deliveries: Promise<void>[] = []
  for (const listener of listeners) {
    try {
      deliveries.push(Promise.resolve(listener(payload)))
    } catch {
      deliveries.push(Promise.resolve())
    }
  }
  if (payload.type === 'data') {
    void Promise.allSettled(deliveries).then(() =>
      window.api.terminalPreview.ack(payload.ptyId, payload.bytes)
    )
  }
}

export function subscribeAgentTerminalPreviewStream(
  ptyId: string,
  listener: TerminalPreviewStreamListener
): () => void {
  const listeners = listenersByPtyId.get(ptyId) ?? new Set<TerminalPreviewStreamListener>()
  listeners.add(listener)
  listenersByPtyId.set(ptyId, listeners)
  disposeGlobalListener ??= window.api.terminalPreview.onData(dispatchTerminalPreviewPayload)

  let subscribed = true
  return () => {
    if (!subscribed) {
      return
    }
    subscribed = false
    listeners.delete(listener)
    if (listeners.size === 0) {
      listenersByPtyId.delete(ptyId)
    }
    if (listenersByPtyId.size > 0) {
      return
    }
    const dispose = disposeGlobalListener
    disposeGlobalListener = null
    dispose?.()
  }
}
