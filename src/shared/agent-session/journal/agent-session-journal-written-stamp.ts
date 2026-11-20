/** Host clock when the agent took a send's write while running no other turn: "Sending…" clears and the
 *  turn's clock starts here. A progress mark only; the provider's echo still settles delivery. Absent
 *  on older hosts. A turn copies its opening send's stamp so forks and reloads keep it. */
export type AgentJournalWrittenStamp = { writtenAt?: number }
