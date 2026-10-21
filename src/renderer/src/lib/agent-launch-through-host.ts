/**
 * A desktop AI-button launch, whose prompt this window pastes once the agent is ready, as main does.
 *
 * This window owns the workspace's tab layout, so it makes the agent's tab at the click, in the
 * split it was asked for, as any new agent tab is made. The tab's pane carries the launch in its own
 * spawn, as "+" carries its command: main plans it with the host's planner and starts it in that
 * pane, at the pane's real size, writing no launch record. A pane whose agent could not start says
 * why.
 */

import { useAppStore } from '@/store'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { persistAgentLaunchTabOrder } from '@/lib/launch-agent-tab-order'
import { rememberAgentLaunchPanePrompt } from '@/lib/agent-launch-pane-prompt'
import { awaitAgentLaunchPaneStart } from '@/lib/agent-launch-pane-start'
import { seedNativeChatAppliedSessionOptions } from '@/components/native-chat/native-chat-session-option-cache'
import { isNativeChatEnabled } from '../../../shared/structured-native-chat-launch-route'
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
    target: { kind: 'existing' as const, worktree: `id:${args.worktreeId}` },
    ...(args.agentArgs !== undefined ? { agentArgs: args.agentArgs } : {}),
    ...(args.cwd ? { cwd: args.cwd } : {}),
    ...stringSessionOptions(args.sessionOptions),
    ...(args.launchSource ? { launchSource: args.launchSource } : {})
  }
}

/** Where the host could turn a launch into a chat (chat is the default), this window's paste has no
 *  terminal to go to, so such a launch keeps main's own path. */
export function windowMakesHostLaunchTab(): boolean {
  return !isNativeChatEnabled(useAppStore.getState().settings)
}

export function launchAgentThroughHost(args: HostAgentLaunchArgs): {
  tabId: string
  /** The tab pane's PTY once its agent started there; null when it could not, or the user closed it. */
  started: Promise<string | null>
} {
  const store = useAppStore.getState()
  const tabId = createBrowserUuid()
  const leafId = createBrowserUuid()
  const started = awaitAgentLaunchPaneStart(tabId, leafId)
  store.createTab(args.worktreeId, args.groupId, undefined, {
    id: tabId,
    initialLeafId: leafId,
    agentLaunchPane: { leafId },
    launchAgent: args.agent,
    quickCommandLabel: args.quickCommandLabel,
    ...(args.pendingActivationSpawn ? { pendingActivationSpawn: true } : {}),
    ...(args.viewMode ? { viewMode: args.viewMode } : {}),
    // Queued before the pane mounts, as "+" queues its command: its first spawn carries the launch.
    pendingStartup: {
      command: '',
      launchAgent: args.agent,
      agentLaunch: { launch: launchParams(args) }
    }
  })
  if (args.cwd?.trim()) {
    store.queueTabInitialCwd(tabId, args.cwd)
  }
  rememberAgentLaunchPanePrompt(tabId, args.prompt)
  seedNativeChatAppliedSessionOptions(tabId, args.agent, args.sessionOptions)
  // Why: without it an activated launch can stay hidden behind an editor.
  store.setActiveTabType('terminal', args.worktreeId)
  persistAgentLaunchTabOrder(args.worktreeId, tabId)
  return { tabId, started }
}
