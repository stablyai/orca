// Beat timings — slow enough to read at a glance.
export const BUBBLE_FLIGHT_MS = 1600
export const BUBBLE_LAND_MS = BUBBLE_FLIGHT_MS + 360
export const BUBBLE_GAP_MS = 3400
export const ORCHESTRATION_CLI_COMMAND_TIMINGS_MS = [250, 2500, 5200, 8600] as const
export const ORCHESTRATION_CLI_COMMAND_LOOP_MS = 12800

export type AgentKey = 'coord-claude' | 'child-codex' | 'child-claude'

export type Beat = {
  from: AgentKey
  to: AgentKey
  recipientMsg?: string
  coordMsg?: string
  // The "send" *is* the "finish" — flipping the spinner to a check the
  // moment the bubble departs reads as the agent wrapping up and reporting
  // back to the orchestrator.
  senderFinishes?: boolean
}

export const PHASE1_BEATS: readonly Beat[] = [
  {
    from: 'coord-claude',
    to: 'child-codex',
    recipientMsg: 'Adding the email_verified column…'
  },
  {
    from: 'coord-claude',
    to: 'child-claude',
    recipientMsg: 'Wiring withSession middleware…'
  },
  {
    from: 'child-codex',
    to: 'coord-claude',
    coordMsg: 'PR 1/2 ready',
    senderFinishes: true
  },
  {
    from: 'child-claude',
    to: 'coord-claude',
    coordMsg: 'PR 2/2 ready',
    senderFinishes: true
  }
]

export const COORD_INITIAL_MSG = 'Splitting auth rewrite into 2 PRs…'
export const CHILD_CODEX_INITIAL_MSG = 'Writing the users table migration…'
export const CHILD_CLAUDE_INITIAL_MSG = 'Sketching withSession middleware…'

export type AgentRowState = 'working' | 'done'

export type RowState = Record<AgentKey, AgentRowState>
export type RowMessages = Record<AgentKey, string>
export type RowFlash = Partial<Record<AgentKey, number>>
export type RowPending = Partial<Record<AgentKey, boolean>>

export const INITIAL_ROW_STATE: RowState = {
  'coord-claude': 'working',
  'child-codex': 'working',
  'child-claude': 'working'
}

export const INITIAL_ROW_MESSAGES: RowMessages = {
  'coord-claude': COORD_INITIAL_MSG,
  'child-codex': CHILD_CODEX_INITIAL_MSG,
  'child-claude': CHILD_CLAUDE_INITIAL_MSG
}
