import type { TuiAgent } from '../agent-launch/catalog/tui-agent'
import type { AgentLaunchTabViewerRule } from '../agent-launch/contracts/agent-launch-tab-publication'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../agent-session/lifecycle/agent-session-resume'
import type { TerminalPaneSplitSource } from '../feature-education/feature-education-telemetry'
import type { WorkerTabStamp } from '../orchestration/workers/worker-tab-stamp'
import type { RuntimeTerminalPresentation } from './runtime/runtime-terminal-contracts'

/** Main's `ui:createTerminal` request: create, reveal or split a terminal tab in the window. */
export type TerminalRevealPayload = {
  requestId?: string
  worktreeId: string
  command?: string
  cwd?: string
  env?: Record<string, string>
  launchConfig?: SleepingAgentLaunchConfig
  resumeProviderSession?: AgentProviderSessionMetadata
  launchToken?: string
  launchAgent?: TuiAgent
  workerTab?: WorkerTabStamp
  viewMode?: 'terminal' | 'chat'
  targetGroupId?: string
  afterTabId?: string
  shellOverride?: string
  title?: string
  ptyId?: string
  activate?: boolean
  focus?: boolean
  presentation?: RuntimeTerminalPresentation
  surfaceOwner?: false
  agentLaunchViewer?: AgentLaunchTabViewerRule
  tabId?: string
  leafId?: string
  splitFromLeafId?: string
  splitDirection?: 'horizontal' | 'vertical'
  splitTelemetrySource?: TerminalPaneSplitSource
}
