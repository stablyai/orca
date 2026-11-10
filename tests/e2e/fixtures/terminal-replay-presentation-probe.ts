import { createTerminalStructuralReplayCoordinator } from '../../../src/renderer/src/lib/pane-manager/terminal-structural-replay-coordinator'

export type TerminalReplayPresentationProbe = {
  waiting: boolean
  completion: Promise<void> | null
  trace: {
    event: string
    time: number
    cols: number
    rows: number
    opacity: string
  }[]
  prepare: (gpu: 'on' | 'off') => Promise<void>
  start: (resize: boolean) => void
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
      window.__store?.setState({
        settings: { ...settings, terminalGpuAcceleration: gpu }
      })
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
  release: () => release(),
  dispose: () => {
    release()
    coordinator.dispose()
    delete screen.dataset.replayPaintProbe
  }
}
window.__terminalReplayPresentationProbe = probe
