import type {
  AgentStatusOrchestrationContext,
  AgentType
} from '../../../../shared/agent-status-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import type { NativeChatSession } from '../../../../shared/native-chat-types'
import type { NativeChatContextMenuActions } from './use-native-chat-context-menu'

type NativeChatOrchestrationProps = {
  orchestrationDispatchStatus?: AgentStatusOrchestrationContext['dispatchStatus']
}

export type NativeChatBridgeViewProps = NativeChatOrchestrationProps & {
  mode?: 'bridge'
  /** The terminal tab hosting the agent. paneKey is `${tabId}:${leafId}`. */
  terminalTabId: string
  /** Whether the hosted terminal surface is currently visible. */
  isVisible: boolean
  /** Specific split leaf this chat surface replaces. */
  paneKey?: string
  /** PTY bound to `paneKey`, used for composer and interactive-card sends. */
  targetPtyId?: string | null
  /** Launch-time agent hint from the TerminalTab, when Orca started one. */
  launchAgent?: TuiAgent | null
  /** Trusted title/foreground fallback for manually-started agents. */
  resolvedAgent?: TuiAgent | null
  /** Whether this pane owns the tab's launch draft; false for split siblings. */
  ownsTabWideLaunchDraft: boolean
  /** Return this pane to the hosted terminal surface. */
  onSwitchToTerminal?: () => void
  /** Current xterm screen reader used to recover agent-reported session state. */
  readTerminalScreen?: () => string | null
  contextMenuActions?: Omit<NativeChatContextMenuActions, 'onPaste'>
}

export type NativeChatStructuredViewProps = NativeChatOrchestrationProps & {
  mode: 'structured'
  tabId: string
  sessionId: string
  target: RuntimeClientTarget
  agent: AgentType
  isVisible: boolean
  allowFileUriLinks: boolean
}

export type NativeChatResolvedViewProps = NativeChatOrchestrationProps & {
  paneKey: string
  agent: NativeChatSession['agent']
  sessionId: string | null
  transcriptPath: string | null
  isVisible: boolean
  targetPtyId: string | null
  terminalTabId: string
  ownsTabWideLaunchDraft: boolean
  onSwitchToTerminal?: () => void
  readTerminalScreen?: () => string | null
  contextMenuActions?: Omit<NativeChatContextMenuActions, 'onPaste'>
}

export type NativeChatViewProps = NativeChatBridgeViewProps | NativeChatStructuredViewProps
