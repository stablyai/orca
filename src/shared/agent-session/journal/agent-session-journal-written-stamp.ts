/** Host clock when the agent took a send's write while running no other turn: "Sending…" clears and the
 *  turn's clock starts here. A progress mark only; the provider's echo still settles delivery. Absent
 *  on older hosts. A turn copies its opening send's stamp so forks and reloads keep it. */
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
