import type { Terminal, IDisposable } from '@xterm/xterm'
import { createOsc133CommandFinishedScanner } from '../../../../../../shared/terminal/output/terminal-osc133-command-finished'
import {
  createTerminalCommandBlockTracker,
  type TerminalCommandBlockTracker
} from './terminal-command-block-tracker'

type TerminalCommandLifecycleOptions = {
  onCommandFinished: (bestEffortExitCode: number | null) => void
  /** OSC 133;C — the shell exec'd a command; the pane's foreground changed. */
  onCommandStarted?: () => void
}

const blockTrackersByTerminal = new WeakMap<Terminal, TerminalCommandBlockTracker>()

export function getTerminalCommandBlockTracker(
  terminal: Terminal
): TerminalCommandBlockTracker | null {
  return blockTrackersByTerminal.get(terminal) ?? null
}

export function createTerminalCommandLifecycle(options: TerminalCommandLifecycleOptions): {
  handlePtyData: (data: string) => void
  attachXtermConsumer: (terminal: Terminal) => IDisposable
  dispose: () => void
} {
  // Shared parsing keeps local/SSH main-side facts identical; renderer parsing still serves remote-runtime and kill-switch-off PTYs.
  const scanner = createOsc133CommandFinishedScanner(options.onCommandFinished, () =>
    options.onCommandStarted?.()
  )
  const disposables: IDisposable[] = []
  let attachedTerminal: Terminal | null = null

  return {
    handlePtyData: scanner.scan,
    attachXtermConsumer(terminal) {
      if (attachedTerminal && attachedTerminal !== terminal) {
        blockTrackersByTerminal.get(attachedTerminal)?.dispose()
        blockTrackersByTerminal.delete(attachedTerminal)
      }
      attachedTerminal = terminal
      blockTrackersByTerminal.get(terminal)?.dispose()
      const tracker = createTerminalCommandBlockTracker(terminal)
      blockTrackersByTerminal.set(terminal, tracker)
      // Consume OSC 133 even without side-effect authority so integration markers never paint.
      const disposable = terminal.parser.registerOscHandler(133, (payload) => {
        tracker.handleOsc133Payload(payload)
        return true
      })
      disposables.push(disposable)
      return disposable
    },
    dispose() {
      scanner.reset()
      if (attachedTerminal) {
        blockTrackersByTerminal.get(attachedTerminal)?.dispose()
        blockTrackersByTerminal.delete(attachedTerminal)
        attachedTerminal = null
      }
      for (const disposable of disposables.splice(0)) {
        disposable.dispose()
      }
    }
  }
}
