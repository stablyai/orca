/** Create the AI-button tab immediately in its requested split; its first pane spawn lets main plan/start the agent at real dimensions without a launch record. The window pastes when ready, and the pane reports startup failure. */

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
  groupId?: string
  /** Kept by the window: a pane whose agent could not start offers to copy it. */
  prompt: string
  /** Absent uses the settings default; `null` means no arguments. */
  agentArgs?: string | null
  cwd?: string
  /** The launch's session options; the host decodes booleans sent as strings by catalog kind. */
  sessionOptions?: Record<string, SessionOptionValue>
  launchSource?: LaunchSource
  quickCommandLabel?: string | null
  /** The launch seeds a workspace being opened, so its spawn must not reshuffle Recent. */
  pendingActivationSpawn?: boolean
  viewMode?: Tab['viewMode']
  suppressStartupUpdatePrompt?: boolean
}

function stringSessionOptions(options: Record<string, SessionOptionValue> | undefined): {
  sessionOptions?: Record<string, string>
} {
  // Why: the launch wire carries strings, so a boolean (Cursor Thinking off) rides as 'false'.
  const strings = Object.entries(options ?? {}).map(([id, value]) => [id, String(value)])
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

/** Keep main’s path when it may choose structured chat; this window’s delayed paste requires a terminal. */
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
      agentLaunch: {
        launch: launchParams(args),
        ...(args.suppressStartupUpdatePrompt ? { suppressStartupUpdatePrompt: true } : {})
      }
    }
  })
  if (args.cwd?.trim()) {
    store.queueTabInitialCwd(tabId, args.cwd)
  }
  rememberAgentLaunchPanePrompt(tabId, args.prompt)
  seedNativeChatAppliedSessionOptions(tabId, args.agent, args.sessionOptions)
  // An activated launch must reveal Terminal or it can remain hidden behind an editor.
  store.setActiveTabType('terminal', args.worktreeId)
  persistAgentLaunchTabOrder(args.worktreeId, tabId)
  return { tabId, started }
}
