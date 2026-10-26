import type { Terminal, IDisposable } from '@xterm/xterm'
import { createOsc133CommandFinishedScanner } from '../../../../shared/terminal-osc133-command-finished'

type TerminalCommandLifecycleOptions = {
  onCommandFinished: (bestEffortExitCode: number | null) => void
  /** OSC 133;C — the shell exec'd a command; the pane's foreground changed. */
  onCommandStarted?: () => void
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

  return {
    handlePtyData: scanner.scan,
    attachXtermConsumer(terminal) {
      // Consume OSC 133 even without side-effect authority so integration markers never paint.
      const disposable = terminal.parser.registerOscHandler(133, () => true)
      disposables.push(disposable)
      return disposable
    },
    dispose() {
      scanner.reset()
      for (const disposable of disposables.splice(0)) {
        disposable.dispose()
      }
    }
  }
}
