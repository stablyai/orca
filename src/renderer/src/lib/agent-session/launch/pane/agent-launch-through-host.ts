/** Allocate the prompt’s owning pane before mount; main plans and starts it at the pane’s real size. */

import { useAppStore } from '@/store/index'

import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../../shared/non-secure-context-uuid'
import { persistAgentLaunchTabOrder } from '@/lib/agent-session/launch/pane/launch-agent-tab-order'
import { rememberAgentLaunchPanePrompt } from '@/lib/agent-session/launch/pane/agent-launch-pane-prompt'
import { awaitAgentLaunchPaneStart } from '@/lib/agent-session/launch/pane/agent-launch-pane-start'
import { seedNativeChatAppliedSessionOptions } from '../../../../../../shared/native-chat/input/native-chat-session-option-cache'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type { LaunchSource } from '../../../../../../shared/telemetry-property-schemas'
import type { Tab } from '../../../../../../shared/tab-types'
import type { SessionOptionValue } from '../../../../../../shared/native-chat/input/native-chat-session-options'

export type HostAgentLaunchArgs = {
  agent: TuiAgent
  worktreeId: string
  groupId?: string
  /** Kept by the window: a pane whose agent could not start offers to copy it. */
  prompt: string
  /** Absent uses the settings default; `null` means no arguments. */
  agentArgs?: string | null
  cwd?: string
  trustWorktreeId?: string
  /** The launch's session options; the host decodes booleans sent as strings by catalog kind. */
  sessionOptions?: Record<string, SessionOptionValue>
  launchSource?: LaunchSource
  quickCommandLabel?: string | null
  /** The launch seeds a workspace being opened, so its spawn must not reshuffle Recent. */
  pendingActivationSpawn?: boolean
  activate?: boolean
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
    ...(args.cwd?.trim() ? { startupCwd: args.cwd } : {}),
    ...(args.activate === false ? { activate: false } : {}),
    ...(args.pendingActivationSpawn ? { pendingActivationSpawn: true } : {}),
    ...(args.viewMode ? { viewMode: args.viewMode } : {}),
    // Queued before the pane mounts, as "+" queues its command: its first spawn carries the launch.
    pendingStartup: {
      ...(args.trustWorktreeId ? { trustWorktreeId: args.trustWorktreeId } : {}),
      command: '',
      launchAgent: args.agent,
      agentLaunch: {
        launch: launchParams(args),
        ...(args.suppressStartupUpdatePrompt ? { suppressStartupUpdatePrompt: true } : {})
      }
    }
  })
  rememberAgentLaunchPanePrompt(tabId, args.prompt)
  seedNativeChatAppliedSessionOptions(tabId, args.agent, args.sessionOptions)
  // An activated launch must reveal Terminal or it can remain hidden behind an editor.
  if (args.activate !== false) {
    store.setActiveTabType('terminal', args.worktreeId)
  }
  persistAgentLaunchTabOrder(args.worktreeId, tabId)
  return { tabId, started }
}
