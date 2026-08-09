export type Breakpoint = {
  id: string
  path: string
  line: number
  column?: number
  condition?: string
  hitCondition?: string
  logMessage?: string
  verified: boolean
  /** DAP-adapter-assigned line/column once the adapter confirms placement. */
  resolvedLine?: number
  resolvedColumn?: number
}
