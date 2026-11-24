export type TerminalSplitOutcomeData = {
  /** The new pane's leaf id: the split's operation id, and what `--retry-split` takes. */
  splitId: string
  tabId: string
  /** True when the window may still create the pane and run its command. */
  splitMayStillComplete: boolean
  nextSteps: string[]
}

/** A split whose outcome the host could not confirm. Its wire code stays `runtime_error`. */
export class TerminalSplitOutcomeError extends Error {
  readonly data: TerminalSplitOutcomeData

  constructor(message: string, data: TerminalSplitOutcomeData) {
    super(message)
    this.name = 'TerminalSplitOutcomeError'
    this.data = data
  }
}
