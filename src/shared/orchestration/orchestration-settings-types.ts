export type OrchestrationSettings = {
  /** Close a finished worker's terminal or chat after a grace period; absent means on. The coordinator's runtime decides. */
  orchestrationWorkerAutoReleaseEnabled?: boolean
  /** Host-local advisory wait; null/absent follow the product default, 0 is explicit Off. */
  orchestrationQuietWorkerMinutes?: number | null
  /** Coordinator agents may allow workers' permission prompts on this machine; absent means off. Not in any agent-writable settings RPC. */
  orchestrationCoordinatorApprovalsEnabled?: boolean
}
