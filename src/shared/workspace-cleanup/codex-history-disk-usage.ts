/** Space Codex chat history takes on one host; each hard-linked rollout counts once. */
export type CodexHistoryDiskUsage = {
  bytes: number
  rollouts: number
  /** False when the walk hit its entry or time budget: `bytes` is then a lower bound. */
  complete: boolean
}
