/** Host time when the provider confirmed receipt of a pending send, clearing “Sending…”. */
export type AgentJournalWrittenStamp = { writtenAt?: number }

/** Only the written stamp changed: views that never read it may keep what they derived. */
export function agentJournalSubmissionsDifferOnlyInStamp(
  previous: readonly (AgentJournalWrittenStamp & object)[],
  next: readonly (AgentJournalWrittenStamp & object)[]
): boolean {
  if (previous.length !== next.length) {
    return false
  }
  for (let index = 0; index < next.length; index += 1) {
    const before = previous[index]
    const after = next[index]
    if (
      before !== after &&
      (before.writtenAt === after.writtenAt ||
        JSON.stringify({ ...before, writtenAt: undefined }) !==
          JSON.stringify({ ...after, writtenAt: undefined }))
    ) {
      return false
    }
  }
  return true
}
