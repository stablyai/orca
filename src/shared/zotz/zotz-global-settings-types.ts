import type { TuiAgent } from '../agent-launch/catalog/tui-agent'

/** Settings only Zotz reads; kept out of GlobalSettings' body so upstream syncs merge cleanly. */
export type ZotzGlobalSettings = {
  /** 'unset' shows the first-run wizard; 'server' keeps the node awake and network-exposed. */
  zotzMachineMode?: 'unset' | 'personal' | 'server'
  /** Catalog agents already offered once, so only ones added later start hidden. */
  zotzSeenTuiAgents?: TuiAgent[]
  /** Check, download and offer releases of the fork; off only when set to false. */
  zotzUpdatesEnabled?: boolean
  /** Hold agent launches until they fit in memory; off only when set to false. */
  zotzAgentQueueEnabled?: boolean
  /** 'orca' brings back upstream's workspace cards; anything else is the simple project list. */
  zotzSidebarLayout?: 'conductor' | 'orca'
}
