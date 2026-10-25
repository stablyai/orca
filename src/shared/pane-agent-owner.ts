import type { AgentType } from './agent-status-types'

/** Optional owner signals preserve launch-first precedence and durable host identity; each caller supplies what it holds. */
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

/** Preserve compatibility precedence until consumers migrate to canonical evidence. Launch intent bootstraps identity;
 * mirrored/restored panes lose it, so fall through to host hooks, completed hooks and sleeping records instead of raw titles.
 * Wrapper titles (OMP’s Pi frames) cannot identify their owner; prefer launch/live hooks to prevent stale records hijacking it. */
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
