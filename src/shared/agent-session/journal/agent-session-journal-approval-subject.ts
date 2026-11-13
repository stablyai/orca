/** What an approval prompt asks about, beyond its tool call: the ask rule that forced it, or a plan. */
export type AgentJournalApprovalMatchedAskRule = {
  source: string
  toolName: string
  ruleContent?: string
}

export type AgentJournalPlanApprovalSubject = {
  kind: 'plan'
  text: string
  filePath?: string
}

declare const agentJournalUnknownKind: unique symbol
/** A kind tag this build does not know. Branded, so it never stands in for a known tag. */
export type AgentJournalUnknownKind = string & { readonly [agentJournalUnknownKind]: true }

/** A subject of a kind a newer Orca wrote: carried as it was, with whatever fields it holds, and
 *  never drawn or approved here. */
export type AgentJournalUnknownApprovalSubject = { readonly kind: AgentJournalUnknownKind }

/** Open, as the journal schema reads it: narrow with `isPlanApprovalSubject` before reading it. */
export type AgentJournalApprovalSubject =
  | AgentJournalPlanApprovalSubject
  | AgentJournalUnknownApprovalSubject
