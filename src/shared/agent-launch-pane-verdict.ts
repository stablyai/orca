/**
 * What a pane an `agent.launch` laid out before its agent existed does instead of starting a shell.
 * Main derives it on the pane's spawn and sends it to the window as a typed value; the spawn itself
 * only fails with `AGENT_LAUNCH_PANE_REFUSED_CODE`, so nothing is parsed out of error text.
 */

import { z } from 'zod'

/** The launch's fate for its pane once nothing more can change it; the tab keeps it for its life. */
export type AgentLaunchPaneOutcome =
  /** The launch failed before its agent ran; `code` is the recorded reason, for the window to word. */
  | { kind: 'not-started'; code: string }
  /** The launch may have started its agent and nothing can tell. */
  | { kind: 'unconfirmed' }

export type AgentLaunchPaneVerdict =
  /** No launch owns the pane, or its agent runs or ran there: the pane's own spawn decides. */
  | { kind: 'proceed' }
  | AgentLaunchPaneOutcome
  /** The launch ran elsewhere or never ran; the host takes the pane back. */
  | { kind: 'withdrawn' }

/** The one error a refused launch pane's spawn fails with; the window shows the verdict instead. */
export const AGENT_LAUNCH_PANE_REFUSED_CODE = 'agent_launch_pane_refused'

/** The pane a verdict is about, as the window addresses it. */
export type AgentLaunchPaneAddress = { worktreeId: string; tabId: string; leafId: string }

export type AgentLaunchPaneVerdictEvent = AgentLaunchPaneAddress & {
  verdict: AgentLaunchPaneVerdict
}

/** A tab's launch-pane state as persisted; a malformed one is dropped, never the session. */
export const agentLaunchPaneOnTabSchema = z
  .object({
    leafId: z.string(),
    operationId: z.string().optional(),
    outcome: z.custom<AgentLaunchPaneOutcome>(isAgentLaunchPaneOutcome).optional()
  })
  .optional()
  .catch(undefined)

export function isAgentLaunchPaneOutcome(value: unknown): value is AgentLaunchPaneOutcome {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    return false
  }
  return (
    value.kind === 'unconfirmed' ||
    (value.kind === 'not-started' && 'code' in value && typeof value.code === 'string')
  )
}
