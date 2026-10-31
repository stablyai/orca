import type { PtyTransport } from './pty-transport-types'
import type { NotificationWorkspaceOwner } from '../../../../shared/notification-source'
import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
import type {
  TerminalResidentBinding,
  TerminalResidentPresentation,
  TerminalResidentServices
} from './terminal-resident-binding'
import type { createTerminalOwnerPolicy } from './pty-connection/terminal-owner-policy'
import type { createTerminalShellInputPolicy } from './pty-connection/terminal-shell-input-policy'
import type { createTerminalInputPolicy } from './pty-connection/terminal-input-policy'
import type { createTerminalForegroundPolicy } from './pty-connection/pane-agent-identity'
import type { createTerminalNotificationPolicy } from './pty-connection/terminal-notification-policy'
import type { createTerminalCompletionPolicy } from './pty-connection/terminal-completion-policy'
import type { createTerminalCommandCodeStatusPolicy } from './terminal-command-code-status-policy'
import type { createTerminalResidentStatusObserver } from './terminal-resident-status-observer'
import type { TerminalResidentPresentations } from './terminal-resident-presentations'

export type TerminalResidentPolicyContext = {
  readonly binding: TerminalResidentBinding
  readonly services: TerminalResidentServices
  readonly identity: Readonly<{
    ptyId: string
    incarnationId: string | null
    runtimeId?: string | null
  }> | null
  transport: PtyTransport | undefined
  workspaceOwner: NotificationWorkspaceOwner | undefined
  ended: boolean
  unsubscribeSettings: () => void
  releaseRendererOwner: (() => void) | undefined
  readonly presentation: TerminalResidentPresentation | null
  readonly presentationPorts: TerminalResidentPresentations
  currentTitle: string | null
  displayPaneId: number | null
  acceptedInputGeneration: number
  readonly commandContext: {
    ordinal: number
    inputGeneration: number
    entry: AgentStatusEntry | undefined
  } | null
  isLive: () => boolean
  getPtyId: () => string | null
  captureCommand: (ordinal: number) => void
  clearSuppressedTitleSideEffects: () => void
  shouldSuppressTitleCompletion: (title: string) => boolean
  setFocusReportSuppressionForAgentCompletion: (
    title: string | undefined,
    agentType: AgentType | undefined
  ) => void
  queueAgentIdleTerminalModeReset: () => void
  readonly owner: ReturnType<typeof createTerminalOwnerPolicy>
  readonly shellInput: ReturnType<typeof createTerminalShellInputPolicy>
  readonly input: ReturnType<typeof createTerminalInputPolicy>
  readonly foreground: ReturnType<typeof createTerminalForegroundPolicy>
  readonly notification: ReturnType<typeof createTerminalNotificationPolicy>
  readonly completion: ReturnType<typeof createTerminalCompletionPolicy>
  readonly commandCode: ReturnType<typeof createTerminalCommandCodeStatusPolicy>
  readonly onAgentStatus: ReturnType<typeof createTerminalResidentStatusObserver>
}
