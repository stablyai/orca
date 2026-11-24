/** Host time when the provider confirmed receipt of a pending send, clearing “Sending…”. */
export type AgentJournalWrittenStamp = { writtenAt?: number }

export function agentJournalSubmissionDiffersOnlyInStamp(
  before: AgentJournalWrittenStamp & object,
  after: AgentJournalWrittenStamp & object
): boolean {
  return (
    before === after ||
    (before.writtenAt !== after.writtenAt &&
      JSON.stringify({ ...before, writtenAt: undefined }) ===
        JSON.stringify({ ...after, writtenAt: undefined }))
  )
}

/** Only the written stamp changed: views that never read it may keep what they derived. */
export function agentJournalSubmissionsDifferOnlyInStamp(
  previous: readonly (AgentJournalWrittenStamp & object)[],
  next: readonly (AgentJournalWrittenStamp & object)[]
): boolean {
  if (previous.length !== next.length) {
    return false
  }
  for (let index = 0; index < next.length; index += 1) {
    if (!agentJournalSubmissionDiffersOnlyInStamp(previous[index], next[index])) {
      return false
    }
  }
  return true
}
