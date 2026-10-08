/**
 * A desktop launch started through the host's `agent.launch`, with no prompt.
 *
 * This window owns the workspace's tab layout, so it makes the agent's tab at the click, in the
 * split it was asked for, as any new agent tab is made. The host records the launch under this
 * click's operation id and starts the agent into that tab's pane. The pane's spawn waits until the
 * host has taken it (`agent-launch-pane-spawn-hold`), then attaches to the agent or says why it could
 * not start. The prompt stays this window's to paste, as main pastes it, once the agent has started.
 */

import { useAppStore } from '@/store'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { persistAgentLaunchTabOrder } from '@/lib/launch-agent-tab-order'
import { rememberAgentLaunchPanePrompt } from '@/lib/agent-launch-pane-prompt'
import {
  holdAgentLaunchPaneSpawn,
  isAgentLaunchPaneSpawnHeld
} from '@/lib/agent-launch-pane-spawn-hold'
import { seedNativeChatAppliedSessionOptions } from '@/components/native-chat/native-chat-session-option-cache'
import { callRuntimeRpc, RuntimeRpcCallError } from '@/runtime/runtime-rpc-client'
import { createAgentSessionOperationId } from '@/runtime/agent-session-operation-id'
import { isAgentLaunchResult } from '../../../shared/agent-launch-intent'
import { AGENT_LAUNCH_TAB_CLOSED_CODE } from '../../../shared/agent-launch-tab-closed'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { prefersStructuredNativeChatByDefault } from '../../../shared/structured-native-chat-launch-route'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { LaunchSource } from '../../../shared/telemetry-events'
import type { Tab } from '../../../shared/tab-types'
import type { SessionOptionValue } from '../../../shared/native-chat-session-options'

export type HostAgentLaunchArgs = {
  agent: TuiAgent
  worktreeId: string
  /** The split the launch was made from; the tab joins it. */
  groupId?: string
  /** Kept by the window: a pane whose agent could not start offers to copy it. */
  prompt: string
  /** Absent uses the settings default; `null` means no arguments. */
  agentArgs?: string | null
  cwd?: string
  /** The launch's session options; only string values reach the host, which reads no others. */
  sessionOptions?: Record<string, SessionOptionValue>
  launchSource?: LaunchSource
  quickCommandLabel?: string | null
  /** The launch seeds a workspace being opened, so its spawn must not reshuffle Recent. */
  pendingActivationSpawn?: boolean
  /** The view the tab opens in, decided as for any new agent tab. */
  viewMode?: Tab['viewMode']
}

/** What became of the launch, as this window must tell it. */
export type HostAgentLaunchOutcome =
  /** The agent was started in this tab's pane, which is attached to it. */
  | { kind: 'started' }
  /** The pane shows how the launch ended: couldn't start, or couldn't confirm it started. */
  | { kind: 'pane-says' }
  /** The user closed the tab while it started, and with it the launch: nothing more to say. */
  | { kind: 'closed-by-user' }
  /** The tab is gone, so the window says it: nothing started, or whether it did is unknown. */
  | { kind: 'not-started'; unconfirmed: boolean; code?: string }

/** Refused at admission: nothing ran under this click, and the host takes back the tab it was shown. */
const ADMISSION_REFUSAL_CODES = new Set([
  'agent_session_operation_invalid',
  'agent_session_operation_conflict',
  'agent_session_operation_expired',
  'agent_session_operation_capacity'
])

function tabExists(worktreeId: string, tabId: string): boolean {
  return (useAppStore.getState().tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === tabId)
}

function closeLaunchTab(worktreeId: string, tabId: string): void {
  if (tabExists(worktreeId, tabId)) {
    useAppStore.getState().closeTab(tabId, { recordInteraction: false })
  }
}

// Only a terminal in this pane is one the window can paste into; anything else, its pane explains.
function outcomeFromResult(result: unknown): HostAgentLaunchOutcome {
  return isAgentLaunchResult(result) && result.outcome.kind === 'terminal'
    ? { kind: 'started' }
    : { kind: 'pane-says' }
}

function stringSessionOptions(options: Record<string, SessionOptionValue> | undefined): {
  sessionOptions?: Record<string, string>
} {
  const strings = Object.entries(options ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  )
  return strings.length > 0 ? { sessionOptions: Object.fromEntries(strings) } : {}
}

function launchParams(args: HostAgentLaunchArgs) {
  return {
    agent: args.agent,
    target: { kind: 'existing', worktree: `id:${args.worktreeId}` },
    ...(args.agentArgs !== undefined ? { agentArgs: args.agentArgs } : {}),
    ...(args.cwd ? { cwd: args.cwd } : {}),
    ...stringSessionOptions(args.sessionOptions),
    ...(args.launchSource ? { launchSource: args.launchSource } : {}),
    ...(args.groupId ? { placement: { groupId: args.groupId } } : {}),
    presentation: 'focused'
  }
}

/**
 * The ledger is bookkeeping: a desktop past its per-caller row cap still gets its agent, through the
 * host's unrecorded launch into the same pane. The refused launch already took back the tab it was
 * shown, so the tab closes and returns at spawn (rare: 512 launches a day); the host's reveal at
 * spawn hands the pane over (`terminal-presentation-ipc-bridge`).
 */
async function launchWithoutRecord(
  args: HostAgentLaunchArgs,
  pane: { tabId: string; leafId: string }
): Promise<HostAgentLaunchOutcome> {
  try {
    return outcomeFromResult(
      await callRuntimeRpc<unknown>({ kind: 'local' }, 'agent.launch', {
        ...launchParams(args),
        paneKey: makePaneKey(pane.tabId, pane.leafId)
      })
    )
  } catch (error) {
    const code = error instanceof RuntimeRpcCallError ? error.code : undefined
    // A pane the host never revealed would open as a shell; one it did holds the agent's terminal.
    if (isAgentLaunchPaneSpawnHeld(pane.tabId, pane.leafId)) {
      closeLaunchTab(args.worktreeId, pane.tabId)
    }
    return { kind: 'not-started', unconfirmed: false, ...(code ? { code } : {}) }
  }
}

async function settleLaunch(
  args: HostAgentLaunchArgs,
  pane: { tabId: string; leafId: string },
  send: Promise<unknown>,
  releaseHold: () => void
): Promise<HostAgentLaunchOutcome> {
  try {
    return outcomeFromResult(await send)
  } catch (error) {
    const code = error instanceof RuntimeRpcCallError ? error.code : undefined
    if (code === AGENT_LAUNCH_TAB_CLOSED_CODE) {
      return { kind: 'closed-by-user' }
    }
    if (code === 'agent_session_operation_capacity') {
      // Awaited: the pane stays held until the unrecorded launch has its answer.
      return await launchWithoutRecord(args, pane)
    }
    // The host took the pane once it showed the tab; a pane it never took would open as a shell,
    // and a refused one is the host's to take back.
    const hostTookPane = !isAgentLaunchPaneSpawnHeld(pane.tabId, pane.leafId)
    if (!hostTookPane || (code !== undefined && ADMISSION_REFUSAL_CODES.has(code))) {
      closeLaunchTab(args.worktreeId, pane.tabId)
      return {
        kind: 'not-started',
        unconfirmed: code === 'agent_session_operation_unknown',
        ...(code ? { code } : {})
      }
    }
    return { kind: 'pane-says' }
  } finally {
    releaseHold()
  }
}

/** Where the host could turn a launch into a chat (chat is the default), this window's paste has no
 *  terminal to go to, so such a launch keeps main's own path. */
export function windowMakesHostLaunchTab(): boolean {
  return !prefersStructuredNativeChatByDefault(useAppStore.getState().settings)
}

export function launchAgentThroughHost(args: HostAgentLaunchArgs): {
  tabId: string
  outcome: Promise<HostAgentLaunchOutcome>
} {
  const store = useAppStore.getState()
  const tabId = createBrowserUuid()
  const leafId = createBrowserUuid()
  // Before the tab exists, so its first mount already waits.
  const releaseHold = holdAgentLaunchPaneSpawn(tabId, leafId)
  const send = callRuntimeRpc<unknown>({ kind: 'local' }, 'agent.launchReplay', {
    ...launchParams(args),
    // A new click is a new operation; the pane is this click's too.
    operationId: createAgentSessionOperationId(),
    paneKey: makePaneKey(tabId, leafId)
  })
  store.createTab(args.worktreeId, args.groupId, undefined, {
    id: tabId,
    initialLeafId: leafId,
    agentLaunchPane: { leafId },
    launchAgent: args.agent,
    quickCommandLabel: args.quickCommandLabel,
    ...(args.pendingActivationSpawn ? { pendingActivationSpawn: true } : {}),
    ...(args.viewMode ? { viewMode: args.viewMode } : {})
  })
  rememberAgentLaunchPanePrompt(tabId, args.prompt)
  seedNativeChatAppliedSessionOptions(tabId, args.agent, args.sessionOptions)
  // Why: without it an activated launch can stay hidden behind an editor.
  store.setActiveTabType('terminal', args.worktreeId)
  persistAgentLaunchTabOrder(args.worktreeId, tabId)
  return { tabId, outcome: settleLaunch(args, { tabId, leafId }, send, releaseHold) }
}
