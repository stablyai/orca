import { isShellProcess } from '../../../shared/agent-detection'
import {
  isClaudeIdentityFrameTitle,
  resolveExplicitTerminalTitleAgentType
} from '../../../shared/terminal-title-agent-type'
import {
  resolveCompatibleAgentTypeForOwner,
  shareCompatibleTitleIdentityGroup
} from '../../../shared/agent-title-owner'
import { isOpenCodeNativeTitle } from '../../../shared/opencode-terminal-title'
import { resolvePaneAgentOwnerRecord } from '../../../shared/pane-agent-owner'
import type { TuiAgent } from '../../../shared/tui-agent'

/**
 * Byte-for-byte snapshot of the pre-tranche-1 tab resolver. It is test-only reference behavior:
 * production callers use `tab-agent-from-signals.ts`, while the decision table needs a stable
 * implementation to measure the renderer migration against.
 */
export function resolveShippingTabAgentBaseline(args: {
  hasObservedAgentSignal: boolean
  isRemote: boolean
  title: string
  defaultTitle?: string
  hookAgent: TuiAgent | null
  siblingHookAgent?: TuiAgent | null
  focusedCompletedHookAgent?: TuiAgent | null
  siblingCompletedHookAgent?: TuiAgent | null
  processAgent?: TuiAgent | null
  processShellForeground?: boolean
  sleepingSessionAgent?: TuiAgent | null
  launchAgent?: TuiAgent
}): TuiAgent | null {
  const launchAgent = args.launchAgent ?? null
  const ownerRecord = resolvePaneAgentOwnerRecord({
    launchAgent,
    hookAgent: args.hookAgent,
    completedHookAgent: args.focusedCompletedHookAgent,
    sleepingSessionAgent: args.sleepingSessionAgent
  })
  const owner = (ownerRecord?.agent ?? null) as TuiAgent | null
  const ownerIsLaunch = ownerRecord?.ownerIsLaunch === true
  const normalize = (
    signal: TuiAgent | null | undefined,
    signalOwner: TuiAgent | null,
    launch = false
  ) =>
    signal
      ? ((resolveCompatibleAgentTypeForOwner(signal, signalOwner, { ownerIsLaunch: launch }) ??
          signal) as TuiAgent)
      : null
  const liveFocused = normalize(args.hookAgent, owner, ownerIsLaunch)
  const liveSibling = normalize(args.siblingHookAgent, launchAgent, Boolean(launchAgent))
  const processShell = !args.isRemote && args.processShellForeground === true
  const hasCompleted =
    args.focusedCompletedHookAgent !== null && args.focusedCompletedHookAgent !== undefined
  const noTitle =
    args.title.trim().length > 0 &&
    (isShellProcess(args.title.trim()) || args.title.trim() === args.defaultTitle?.trim())
  const idleFocused =
    !args.isRemote && (noTitle || processShell) && hasCompleted
      ? null
      : normalize(args.focusedCompletedHookAgent, owner, ownerIsLaunch)
  const idleSibling = normalize(args.siblingCompletedHookAgent, launchAgent, Boolean(launchAgent))
  const explicitTitle = normalize(
    resolveExplicitTerminalTitleAgentType(args.title),
    owner,
    ownerIsLaunch
  )
  const prior = idleFocused ?? launchAgent
  const nativeOpenCode = explicitTitle === 'opencode' && isOpenCodeNativeTitle(args.title)
  const titleClaims = explicitTitle !== 'claude' || isClaudeIdentityFrameTitle(args.title)
  const titleReclaims =
    prior !== null &&
    explicitTitle !== null &&
    explicitTitle !== prior &&
    !shareCompatibleTitleIdentityGroup(resolveExplicitTerminalTitleAgentType(args.title), prior) &&
    titleClaims &&
    (args.hasObservedAgentSignal || hasCompleted || nativeOpenCode)
  const titleAgent =
    processShell || args.sleepingSessionAgent || (nativeOpenCode && idleFocused !== null)
      ? null
      : titleReclaims
        ? explicitTitle
        : prior
          ? null
          : explicitTitle
  const launchedExit =
    !liveFocused &&
    !liveSibling &&
    !args.processAgent &&
    ((!args.isRemote && args.processShellForeground && args.hasObservedAgentSignal) ||
      (noTitle && (hasCompleted || (!args.isRemote && args.hasObservedAgentSignal))))
  const processAgent = normalize(args.processAgent, owner, ownerIsLaunch)
  return (
    liveFocused ??
    processAgent ??
    titleAgent ??
    idleFocused ??
    args.sleepingSessionAgent ??
    (launchedExit ? null : launchAgent) ??
    liveSibling ??
    idleSibling
  )
}
