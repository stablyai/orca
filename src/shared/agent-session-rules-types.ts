export type AgentSessionRuleSource = 'builtin' | 'custom'

export type AgentSessionRule = {
  /** Stable id; builtin rules keep a fixed id such as 'builtin-graphify'. */
  id: string
  /** Settings UI display name. */
  label: string
  /** Rule text injected verbatim into every agent session, agent-agnostic. */
  content: string
  enabled: boolean
  /** 'builtin' rules can only be disabled, not deleted, from Settings. */
  source: AgentSessionRuleSource
}

export type AgentSessionRulesSettings = {
  /** Master switch; same semantics as sourceControlAi.enabled. */
  enabled: boolean
  /** Ordered; builtin rules are seeded into this list. */
  rules: AgentSessionRule[]
  /** Builtin rule ids ever merged into `rules`, so a builtin the user removed
   *  is not resurrected the next time this profile is normalized. */
  seenBuiltinRuleIds?: string[]
}

export type RepoAgentSessionRuleOverrides = {
  /** undefined/null inherits the global master switch; true/false overrides it for this repo. */
  enabled?: boolean | null
  /** Ids of global rules (builtin or custom) to suppress for this repo, without touching the global list. */
  disabledRuleIds?: string[]
  /** Rules that apply only to this repo (source should be 'custom'). */
  extraRules?: AgentSessionRule[]
}
