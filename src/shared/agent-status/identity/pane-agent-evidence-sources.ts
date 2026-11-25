/** Evidence classes in canonical strength order, strongest first. */
export const PANE_AGENT_EVIDENCE_SOURCES = [
  /** A live provider hook for a turn in progress. The agent is running and said so. */
  'live-hook',
  /** The pane's foreground process, as read on the execution host. */
  'process',
  /** Orca launched, resumed, or accepted a command for this agent. A fact Orca owns. */
  'launch',
  /** A provider hook from a turn that finished. Still authoritative about identity. */
  'completed-hook',
  /** A sleeping session record restored for this pane. */
  'sleeping-session',
  /** Another pane in the same tab. Tab-level surfaces only; never pane-scoped routing. */
  'sibling',
  /** Parsed from the terminal title. A decoration channel; anyone can type an agent's name. */
  'title'
] as const

export type PaneAgentEvidenceSource = (typeof PANE_AGENT_EVIDENCE_SOURCES)[number]
