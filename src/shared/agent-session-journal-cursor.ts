/** Epoch-qualified position in one journal. `sequence` 0 means "before the first row". */
export type AgentJournalCursor = {
  epoch: string
  sequence: number
}
