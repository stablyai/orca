/** What an approval prompt asks about, beyond its tool call: the ask rule that forced it, a plan, or a page to open. */
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

/** A page the agent asks the person to open outside Orca, such as an MCP server's sign-in. Only
 *  http(s) URLs are written. `completedAt` is set once the agent reports the page's work finished. */
export type AgentJournalUrlApprovalSubject = {
  kind: 'url'
  url: string
  completedAt?: number
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
  | AgentJournalUrlApprovalSubject
  | AgentJournalUnknownApprovalSubject
