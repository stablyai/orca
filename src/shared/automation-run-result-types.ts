/** Agent-reported incomplete result; `resolvedAt` keeps recovered warnings as history. */
export type AutomationRunWarning = {
  key: string
  message: string
  impact: string | null
  evidence: string | null
  firstReportedAt: number
  lastReportedAt: number
  reportCount: number
  resolvedAt: number | null
  resolution: string | null
}

export type AutomationRunOutputFormat = 'html' | 'markdown'

/** A report file the agent attached; content lives beside the store, keyed by run and id. */
export type AutomationRunOutput = {
  id: string
  title: string
  format: AutomationRunOutputFormat
  bytes: number
  attachedAt: number
}

export type AutomationRunReportedFailure = {
  message: string
  reportedAt: number
}
