import { createTerminalStructuralReplayCoordinator } from '../../../src/renderer/src/lib/pane-manager/terminal-structural-replay-coordinator'
import type { PtyBufferSnapshot } from '../../../src/renderer/src/components/terminal-pane/pty-transport'
import type { PtyDataMeta } from '../../../src/renderer/src/components/terminal-pane/pty-dispatcher'

export type TerminalReplayPresentationProbe = {
  waiting: boolean
  completion: Promise<void> | null
  trace: { event: string; time: number; cols: number; rows: number; opacity: string }[]
  prepare: (gpu: 'on' | 'off') => Promise<void>
  start: (resize: boolean) => void
  armRestore: (ptyId: string, paneKey: string) => void
  resolveRestore: () => void
  release: () => void
  dispose: () => void
}

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Window augmentation requires declaration merging.
  interface Window {
    __terminalReplayPresentationProbe?: TerminalReplayPresentationProbe
  }
}

const state = window.__store?.getState()
const tabId = state?.activeTabId
const manager = tabId ? window.__paneManagers?.get(tabId) : null
const pane = manager?.getActivePane() ?? manager?.getPanes()[0]
if (!pane) {
  throw new Error('No terminal pane for the replay presentation probe')
}
const terminal = pane.terminal
const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
if (!screen) {
  throw new Error('No terminal screen for the replay presentation probe')
}
screen.dataset.replayPaintProbe = 'true'
let { cols, rows } = terminal
const coordinator = createTerminalStructuralReplayCoordinator(terminal)
const write = (data: string): Promise<void> =>
  new Promise((resolve) => terminal.write(data, resolve))
let release = (): void => {}
let resolveRestore = (): void => {}
let disposeRestore = (): void => {}
const trace = (event: string): void => {
  probe.trace.push({
    event,
    time: performance.now(),
    cols: terminal.cols,
    rows: terminal.rows,
    opacity: screen.style.opacity
  })
}
const probe: TerminalReplayPresentationProbe = {
  waiting: false,
  completion: null,
  trace: [],
  prepare: async (gpu) => {
    const settings = window.__store?.getState().settings
    if (settings) {
      window.__store?.setState({ settings: { ...settings, terminalGpuAcceleration: gpu } })
    }
    manager?.setTerminalGpuAcceleration?.(gpu)
    terminal.options.cursorBlink = false
    const frame = Array.from(
      { length: rows - 1 },
      (_, row) =>
        `\x1b[${row + 1};1H\x1b[44m${`RETAINED_FRAME_${row} `.padEnd(cols - 1, '.')}\x1b[0m`
    ).join('')
    await write(`\x1b[2J\x1b[H\x1b[?25l${frame}`)
    terminal.focus()
  },
  start: (resize) => {
    ;({ cols, rows } = terminal)
    probe.waiting = false
    trace('replay-queued')
    probe.completion = coordinator
      .run(
        async () => {
          trace('clear-start')
          await write('\x1b[2J\x1b[3J\x1b[H')
          trace('clear-parsed')
          if (resize) {
            terminal.resize(
              Math.max(20, Math.floor(cols * 0.65)),
              Math.max(10, Math.floor(rows * 0.65))
            )
          }
          await write('REPLAY_CHANGED_OUTPUT\r\nNew tool output while hidden\r\n')
          trace('replay-parsed')
          await new Promise<void>((resolve) => {
            release = resolve
            probe.waiting = true
          })
        },
        {
          afterRestore: () => {
            terminal.resize(cols, rows)
            trace('destination-fit')
          }
        }
      )
      .then(() => trace('released'))
  },
  armRestore: (ptyId, paneKey) => {
    ;({ cols, rows } = terminal)
    const harness: Window & {
      __terminalHiddenSnapshotOverride?: {
        setPending: (ptyId: string, snapshot: PtyBufferSnapshot) => void
        resolve: (ptyId: string) => void
        clear: (ptyId: string) => void
      }
      __terminalPtyDataInjection?: {
        inject: (paneKey: string, data: string, meta?: PtyDataMeta) => boolean
      }
    } = window
    const snapshots = harness.__terminalHiddenSnapshotOverride
    if (!snapshots || !harness.__terminalPtyDataInjection) {
      throw new Error('Hidden-output restore harness is unavailable')
    }
    trace('hidden-gap-armed')
    const surfaceStack = screen.closest('[data-worktree-reveal-id]')?.parentElement
    const observer = new MutationObserver(() => {
      trace(surfaceStack?.dataset.terminalRevealHeld ? 'workspace-held' : 'workspace-presented')
    })
    if (surfaceStack) {
      observer.observe(surfaceStack, {
        attributes: true,
        attributeFilter: ['data-terminal-reveal-held']
      })
    }
    snapshots.setPending(ptyId, {
      data: 'REPLAY_CHANGED_OUTPUT\r\nNew tool output while hidden\r\n',
      cols: Math.max(20, Math.floor(cols * 0.65)),
      rows: Math.max(10, Math.floor(rows * 0.65))
    })
    const originalWrite = terminal.write
    let armed = true
    let blocked = false
    const completions: (() => void)[] = []
    terminal.write = (data, callback): void => {
      if (armed && typeof data === 'string' && data.includes('REPLAY_CHANGED_OUTPUT')) {
        blocked = true
      }
      originalWrite.call(terminal, data, () => {
        if (blocked && callback) {
          completions.push(callback)
          probe.waiting = true
          trace('restore-parse-held')
        } else {
          callback?.()
        }
      })
    }
    release = () => {
      trace('parse-released')
      armed = false
      blocked = false
      for (const complete of completions.splice(0)) {
        complete()
      }
    }
    resolveRestore = () => {
      trace('snapshot-response-released')
      snapshots.resolve(ptyId)
    }
    disposeRestore = () => {
      observer.disconnect()
      terminal.write = originalWrite
      snapshots.clear(ptyId)
    }
    if (
      !harness.__terminalPtyDataInjection.inject(paneKey, '', {
        droppedOutput: true,
        background: true
      })
    ) {
      throw new Error('No hidden-output callback for the retained pane')
    }
  },
  resolveRestore: () => resolveRestore(),
  release: () => release(),
  dispose: () => {
    release()
    disposeRestore()
    coordinator.dispose()
    delete screen.dataset.replayPaintProbe
  }
}
window.__terminalReplayPresentationProbe = probe
