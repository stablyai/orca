import { isShellProcess } from '../../../shared/agent-detection'
import {
  resolveCanonicalPaneAgentIdentity,
  type ForegroundProcessProof
} from '../../../shared/pane-agent-identity-adapter'
import type { PaneAgentRunKey } from '../../../shared/pane-agent-identity-resolver'
import { resolveExplicitTerminalTitleAgentType } from '../../../shared/terminal-title-agent-type'
import type { TuiAgent } from '../../../shared/tui-agent'

// A shell name or the tab's neutral default title (where inferred-interrupt reset parks it); blank titles are no evidence.
function titleShowsNoAgent(title: string, defaultTitle?: string): boolean {
  const trimmed = title.trim()
  return trimmed.length > 0 && (isShellProcess(trimmed) || trimmed === defaultTitle?.trim())
}

/**
 * Probe-free evidence a launched agent exited: title shows no agent, no live
 * hook remains, and either the hook completed or observed activity vanished.
 * Vanished-activity is local-only — remote rows also drop on transport blips.
 */
export function resolveLaunchedAgentExitEvidence(args: {
  title: string
  defaultTitle?: string
  isRemote: boolean
  hasObservedAgentSignal: boolean
  hookAgent: TuiAgent | null
  siblingHookAgent?: TuiAgent | null
  hasCompletedHook: boolean
  processAgent?: TuiAgent | null
  processShellForeground?: boolean
}): boolean {
  if (args.hookAgent || args.siblingHookAgent || args.processAgent) {
    return false
  }
  // Why: OSC 133;D (foreground back at shell) is title-independent exit evidence; local-only — remote panes have no shell-foreground producer.
  if (!args.isRemote && args.processShellForeground && args.hasObservedAgentSignal) {
    return true
  }
  if (!titleShowsNoAgent(args.title, args.defaultTitle)) {
    return false
  }
  return args.hasCompletedHook || (!args.isRemote && args.hasObservedAgentSignal)
}

/**
 * Resolve the tab's display identity through the canonical pane ladder.
 *
 * This adapter only translates the tab's focused/sibling slots. A bare process name remains a
 * hint until a host-stamped proof is supplied, and title parsing belongs to the canonical call.
 * The source order is live-hook > process > launch > completed-hook > sleeping-session > sibling
 * > title. Launch intentionally outranks completed-hook for now: a completed hook is newer
 * evidence in the abstract, but run-key staleness is not wired (undefined run keys are eligible),
 * so it can describe a previous occupant of a reused pane; launch is scoped to this pane's setup.
 * Once production supplies run keys, the ordering must be revisited (see the expiry test).
 */
export function resolveTabAgentFromSignals(args: {
  hasObservedAgentSignal: boolean
  isRemote: boolean
  title: string
  defaultTitle?: string
  hookAgent: TuiAgent | null
  siblingHookAgent?: TuiAgent | null
  focusedCompletedHookAgent?: TuiAgent | null
  siblingCompletedHookAgent?: TuiAgent | null
  siblingAgents?: readonly TuiAgent[]
  processAgent?: TuiAgent | null
  processProof?: ForegroundProcessProof | null
  processShellForeground?: boolean
  sleepingSessionAgent?: TuiAgent | null
  launchAgent?: TuiAgent
  hookRun?: PaneAgentRunKey
  completedHookRun?: PaneAgentRunKey
  launchRun?: PaneAgentRunKey
  sleepingRun?: PaneAgentRunKey
  currentRun?: PaneAgentRunKey
}): TuiAgent | null {
  const siblingAgents = [
    args.siblingHookAgent,
    args.siblingCompletedHookAgent,
    ...(args.siblingAgents ?? [])
  ].filter((agent): agent is TuiAgent => agent !== null && agent !== undefined)
  const identity = resolveCanonicalPaneAgentIdentity({
    hookAgent: args.hookAgent,
    hookIsLive: true,
    hookRun: args.hookRun,
    completedHookAgent: args.focusedCompletedHookAgent,
    completedHookRun: args.completedHookRun,
    launchAgent: args.launchAgent ?? null,
    launchRun: args.launchRun,
    foregroundAgent: args.processAgent,
    processProof: args.processProof,
    sleepingSessionAgent: args.sleepingSessionAgent,
    sleepingRun: args.sleepingRun,
    siblingAgents,
    allowSibling: true,
    title: args.title,
    ...(siblingAgents.length === 0
      ? {
          uncoveredFallback: {
            agent: resolveExplicitTerminalTitleAgentType(args.title),
            titleOnly: true
          }
        }
      : {}),
    currentRun: args.currentRun
  })
  if (!args.isRemote && args.processShellForeground && identity.source === 'title') {
    return null
  }
  return identity.agent
}
