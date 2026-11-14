/** Setup content hashes a client approved; hosts run shared setup only for a created worktree that matches one. */
export type ApprovedSetupHashes = {
  /** The content confirmed for this create. */
  approvedSetupHash?: string
  /** Earlier approvals for the repo, so a branch with a previously approved script still runs setup. Older hosts ignore it. */
  approvedSetupHashes?: string[]
}

export function pickApprovedSetupHashes(source: ApprovedSetupHashes): ApprovedSetupHashes {
  return {
    ...(source.approvedSetupHash !== undefined
      ? { approvedSetupHash: source.approvedSetupHash }
      : {}),
    ...(source.approvedSetupHashes?.length
      ? { approvedSetupHashes: source.approvedSetupHashes }
      : {})
  }
}
