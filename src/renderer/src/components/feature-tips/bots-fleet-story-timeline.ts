// The bots intro story as a pure function of time: you ask from Slack, the bot runs a fleet of
// coding agents, a reviewer bot checks the work, and a PR lands. Every frame derives from `t`
// (seconds into one loop), so pausing, replaying and reduced motion all read the same frame.

export type FleetAgentKind = 'claude' | 'codex'

export type FleetAgentRow = {
  agent: FleetAgentKind
  /** Seconds the row spends running before it checks off. */
  runFor: number
  added: number
  removed: number
}

export const FLEET_AGENTS: readonly FleetAgentRow[] = [
  { agent: 'claude', runFor: 3.2, added: 164, removed: 41 },
  { agent: 'codex', runFor: 4.4, added: 201, removed: 38 },
  { agent: 'claude', runFor: 5, added: 31, removed: 12 },
  { agent: 'codex', runFor: 3.8, added: 16, removed: 5 }
]

/** Story seconds shown as agent minutes, so a 5s run reads as a believable 4m. */
export const AGENT_CLOCK_SCALE = 48

const TYPING_AT = 0.5
const MESSAGE_AT = 1.6
const REACTION_AT = 2.4
const BOT_AT = 3.1
const STARTING_AT = 4
const ROW_STAGGER = 0.3
const RUN_AT = STARTING_AT + ROW_STAGGER * FLEET_AGENTS.length
const AGENTS_DONE_AT = RUN_AT + Math.max(...FLEET_AGENTS.map((row) => row.runFor))
const REVIEW_AT = AGENTS_DONE_AT + 0.6
const STEP_SECONDS = 1.15
const MEMORY_AT = REVIEW_AT + STEP_SECONDS
const BOT_DONE_AT = MEMORY_AT + STEP_SECONDS
const PR_AT = BOT_DONE_AT + 0.4
const CHECKS_AT = PR_AT + 0.6
const CHECK_STEP = 0.35
const CHECKS_DONE_AT = CHECKS_AT + CHECK_STEP * 4
const REVIEWED_AT = CHECKS_DONE_AT + 0.3
const CURSOR_AT = REVIEWED_AT + 0.5
const HOVER_AT = CURSOR_AT + 1
const CLICK_AT = HOVER_AT + 0.3
const CLICK_RELEASE_AT = CLICK_AT + 0.15
/** The last frame worth stopping on: the PR's Review button just clicked. */
export const STORY_END = CLICK_RELEASE_AT + 1
const FADE_AT = CLICK_RELEASE_AT + 3.4
/** One loop, including the fade out before it plays again. */
export const STORY_LOOP = FADE_AT + 0.5

export type FleetStatus =
  | { kind: 'planning' }
  | { kind: 'starting'; count: number }
  | { kind: 'running'; count: number }
  | { kind: 'review' }
  | { kind: 'memory' }
  | { kind: 'done' }

export type FleetAgentFrame = {
  shown: boolean
  /** 0..1 progress, eased so bars start quick and settle. */
  progress: number
  done: boolean
  /** Agent-clock seconds, frozen once the row checks off. */
  clockSeconds: number
  /** Which of reading / editing / testing the running row shows. */
  phase: 0 | 1 | 2
}

export type FleetStoryFrame = {
  /** 0: you ask, 1: the bot works, 2: you review. -1 between loops. */
  beat: -1 | 0 | 1 | 2
  typing: boolean
  message: boolean
  reaction: boolean
  bot: boolean
  status: FleetStatus
  agents: FleetAgentFrame[]
  reviewRow: 'hidden' | 'running' | 'done'
  memoryRow: 'hidden' | 'running' | 'done'
  pr: boolean
  checksPassed: number
  reviewed: boolean
  cursor: 'hidden' | 'away' | 'on-button'
  hover: boolean
  click: boolean
  /** The stage fades out before the loop restarts. */
  fading: boolean
  /** Bumps whenever new content lands, so the stage can follow the newest row. */
  contentKey: number
}

function agentFrame(row: FleetAgentRow, index: number, t: number): FleetAgentFrame {
  const shown = t >= STARTING_AT + ROW_STAGGER * index
  const running = Math.max(0, t - RUN_AT)
  const linear = Math.min(1, running / row.runFor)
  const done = linear >= 1
  return {
    shown,
    progress: 1 - (1 - linear) ** 1.6,
    done,
    clockSeconds: Math.min(running, row.runFor) * AGENT_CLOCK_SCALE,
    phase: linear < 1 / 3 ? 0 : linear < 2 / 3 ? 1 : 2
  }
}

function statusAt(t: number, agentsLeft: number): FleetStatus {
  if (t >= BOT_DONE_AT) {
    return { kind: 'done' }
  }
  if (t >= MEMORY_AT) {
    return { kind: 'memory' }
  }
  if (t >= REVIEW_AT) {
    return { kind: 'review' }
  }
  if (t >= RUN_AT) {
    return { kind: 'running', count: agentsLeft }
  }
  if (t >= STARTING_AT) {
    return { kind: 'starting', count: FLEET_AGENTS.length }
  }
  return { kind: 'planning' }
}

function stepState(t: number, at: number): 'hidden' | 'running' | 'done' {
  return t < at ? 'hidden' : t < at + STEP_SECONDS ? 'running' : 'done'
}

export function fleetStoryFrame(t: number): FleetStoryFrame {
  const agents = FLEET_AGENTS.map((row, index) => agentFrame(row, index, t))
  const agentsLeft = agents.filter((agent) => !agent.done).length
  const checksPassed =
    t < CHECKS_AT ? 0 : Math.min(4, Math.floor((t - CHECKS_AT) / CHECK_STEP + 1e-9))
  const reviewRow = stepState(t, REVIEW_AT)
  const memoryRow = stepState(t, MEMORY_AT)
  const contentKey = [
    t >= TYPING_AT,
    t >= MESSAGE_AT,
    t >= BOT_AT,
    ...agents.map((agent) => agent.shown),
    reviewRow !== 'hidden',
    memoryRow !== 'hidden',
    t >= PR_AT,
    t >= REVIEWED_AT
  ].filter(Boolean).length
  const fading = t >= FADE_AT
  return {
    beat: fading ? -1 : t < BOT_AT ? 0 : t < BOT_DONE_AT ? 1 : 2,
    typing: t >= TYPING_AT && t < MESSAGE_AT,
    message: t >= MESSAGE_AT,
    reaction: t >= REACTION_AT,
    bot: t >= BOT_AT,
    status: statusAt(t, agentsLeft),
    agents,
    reviewRow,
    memoryRow,
    pr: t >= PR_AT,
    checksPassed,
    reviewed: t >= REVIEWED_AT,
    cursor: t < CURSOR_AT || t >= FADE_AT ? 'hidden' : t < CURSOR_AT + 0.15 ? 'away' : 'on-button',
    hover: t >= HOVER_AT && t < CLICK_AT,
    click: t >= CLICK_AT && t < CLICK_RELEASE_AT,
    fading,
    contentKey
  }
}

/** "4m 05s" or "48s", as the agent rows count up. */
export function formatAgentClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = Math.floor(seconds % 60)
  return minutes ? `${minutes}m ${String(rest).padStart(2, '0')}s` : `${rest}s`
}
