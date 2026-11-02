import type { TerminalResidentPresentation } from './terminal-resident-binding'

/** Active ports fan out rendering; the execution keeps one semantic consumer. */
export class TerminalResidentPresentations {
  private readonly ports = new Set<TerminalResidentPresentation>()
  private readonly presentation: TerminalResidentPresentation = {
    paneId: -1,
    isVisible: () => Array.from(this.ports).some((port) => port.isVisible()),
    showTitle: (...args) => {
      for (const port of this.ports) {
        port.showTitle(...args)
      }
    },
    resetInputModes: () => {
      for (const port of this.ports) {
        port.resetInputModes()
      }
    },
    confirmedShell: () => {
      for (const port of this.ports) {
        port.confirmedShell?.()
      }
    },
    preservesSleepingRecord: (...args) =>
      Array.from(this.ports).some((port) => port.preservesSleepingRecord?.(...args)),
    setFocusReportSuppression: (...args) => {
      for (const port of this.ports) {
        port.setFocusReportSuppression(...args)
      }
    },
    clearFocusReportSuppression: () => {
      for (const port of this.ports) {
        port.clearFocusReportSuppression()
      }
    },
    markBracketedPasteInterrupted: () => {
      for (const port of this.ports) {
        port.markBracketedPasteInterrupted()
      }
    },
    onAgentExited: () => {
      for (const port of this.ports) {
        port.onAgentExited()
      }
    },
    setMode2031: (...args) => {
      for (const port of this.ports) {
        port.setMode2031(...args)
      }
    }
  }
  get current(): TerminalResidentPresentation | null {
    return this.ports.size ? this.presentation : null
  }
  attach(port: TerminalResidentPresentation): () => void {
    this.ports.add(port)
    return () => {
      this.ports.delete(port)
    }
  }
  clear(): void {
    this.ports.clear()
  }
}
