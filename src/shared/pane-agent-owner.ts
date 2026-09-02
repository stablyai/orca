import type { AgentType } from './agent-status-types'

/**
 * The owner-evidence signals a terminal pane can carry, strongest launch intent
 * first, ending in the durable host-stamped identity. Every field is optional so
 * each call site passes only what it holds; absent signals are skipped.
 */
export type PaneAgentOwnerSignals = {
  /** Tab-scoped launch intent — what Orca launched into this tab. */
  launchAgent?: AgentType | null
  /** Never-cleared per-connection launch seed (pane connection only). */
  startupLaunchAgent?: AgentType | null
  /** Startup-provided initial agent status (pane connection only). */
  initialStatusAgent?: AgentType | null
  /** Agent inferred from a manually typed shell command (pane connection only). */
  commandInferredAgent?: AgentType | null
  /** Live focused-pane hook identity — host-stamped, published, mirror-safe. */
  hookAgent?: AgentType | null
  /** Live sibling-pane hook identity. */
  siblingHookAgent?: AgentType | null
  /** Last completed focused-pane hook — survives the live hook row clearing. */
  completedHookAgent?: AgentType | null
  /** Last completed sibling-pane hook. */
  siblingCompletedHookAgent?: AgentType | null
  /** Hibernated session record — the final durable identity while a pane sleeps. */
  sleepingSessionAgent?: AgentType | null
}

export type ResolvedPaneAgentOwner = {
  agent: AgentType
  /** User-selected launch/startup/typed-command identity — not a status frame. */
  ownerIsLaunch: boolean
}

const PANE_OWNER_RANK: readonly {
  key: keyof PaneAgentOwnerSignals
  ownerIsLaunch: boolean
}[] = [
  { key: 'launchAgent', ownerIsLaunch: true },
  { key: 'startupLaunchAgent', ownerIsLaunch: true },
  { key: 'initialStatusAgent', ownerIsLaunch: true },
  { key: 'commandInferredAgent', ownerIsLaunch: true },
  { key: 'hookAgent', ownerIsLaunch: false },
  { key: 'siblingHookAgent', ownerIsLaunch: false },
  { key: 'completedHookAgent', ownerIsLaunch: false },
  { key: 'siblingCompletedHookAgent', ownerIsLaunch: false },
  { key: 'sleepingSessionAgent', ownerIsLaunch: false }
]

/**
 * The single authoritative resolver for "which agent owns this pane", shared by
 * the tab-icon resolver, the terminal-pane display/renderer owner, and the
 * mirrored-tab title owner so they cannot drift apart.
 *
 * Why this precedence: launch intent is the authoritative bootstrap before any
 * process signal exists, so it leads. Once launch metadata is gone — a mirrored
 * or restored pane drops the host-owned launchAgent — the owner must fall
 * through to a durable pane identity rather than to the raw title, because a
 * wrapper agent's title (OMP emits Pi-compatible frames) cannot be told apart
 * from the agent it wraps. The host-stamped hook identity is that durable,
 * published, mirror-safe anchor; the last completed hook and the hibernated
 * session record carry it across the windows where no live hook exists. Ranking
 * launch/live-hook above the completed/sleeping records keeps a genuine pane on
 * its real agent and stops a stale record from hijacking it.
 */
export function resolvePaneAgentOwnerRecord(
  signals: PaneAgentOwnerSignals
): ResolvedPaneAgentOwner | null {
  for (const { key, ownerIsLaunch } of PANE_OWNER_RANK) {
    const agent = signals[key]
    if (agent) {
      return { agent, ownerIsLaunch }
    }
  }
  return null
}

export function resolvePaneAgentOwner(signals: PaneAgentOwnerSignals): AgentType | null {
  return resolvePaneAgentOwnerRecord(signals)?.agent ?? null
}
