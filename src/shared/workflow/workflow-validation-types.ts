export type WorkflowValidationIssue = {
  severity: 'error' | 'warning'
  code: string
  message: string
  nodeId: string | null
  edgeId: string | null
}

/** What the execution host proved it has; null fields mean unknown, which warns instead of refusing. */
export type WorkflowHostCapabilities = {
  /** Agents whose CLI the host detected on PATH. */
  detectedAgents: readonly string[] | null
  /** Installed skill names per provider-agnostic discovery. */
  installedSkills: readonly string[] | null
  /** OpenCode model choices need a fresh local terminal on a supported host. */
  openCodeModelLaunchSupported: boolean
}
