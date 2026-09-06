import { useCallback } from 'react'
import { AGENT_COMPACT_COMMAND } from '../../../../shared/agent-compaction'
import { EMPTY_AGENT_SESSION_CONTEXT } from '../../../../shared/agent-session-context'
import type { AgentSessionContextSnapshot } from '../../../../shared/agent-session-context'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { SlashCommandSuggestion } from '../../../../shared/native-chat-slash-commands'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import type { NativeChatSessionOptionDispatchCommand } from './native-chat-session-option-command-dispatch'
import { useNativeChatSessionOptions } from './use-native-chat-session-options'

export function useNativeChatComposerSessionControl(args: {
  agent: AgentType
  commands: readonly SlashCommandSuggestion[]
  terminalTabId: string
  targetPtyId: string | null
  dispatchCommand: NativeChatSessionOptionDispatchCommand
  restartSession?: (values: Record<string, SessionOptionValue>) => Promise<void> | void
  reportedModel?: string | null
  reportedEffort?: string | null
  context?: AgentSessionContextSnapshot
  onCompactionRequested?: () => void
  onAgentPicker?: () => void
  readTerminalScreen?: () => string | null
}): {
  sessionOptionsSurface: ReturnType<typeof useNativeChatSessionOptions>['surface']
  sessionOptionsSnapshot: ReturnType<typeof useNativeChatSessionOptions>['snapshot']
  context: AgentSessionContextSnapshot
  canCompact: boolean
  onCompact: () => Promise<void>
} {
  const {
    agent,
    commands,
    terminalTabId,
    targetPtyId,
    dispatchCommand,
    restartSession,
    reportedModel,
    reportedEffort,
    context = EMPTY_AGENT_SESSION_CONTEXT,
    onCompactionRequested,
    onAgentPicker,
    readTerminalScreen
  } = args
  const reportedContextWindow =
    agent === 'claude' && context.maxTokens !== null
      ? context.maxTokens >= 1_000_000
        ? '1m'
        : 'standard'
      : null
  const { surface, snapshot } = useNativeChatSessionOptions({
    agent,
    terminalTabId,
    targetPtyId,
    dispatchCommand,
    restartSession,
    reportedModel,
    reportedEffort,
    reportedContextWindow,
    reportedFastMode: context.fastMode,
    onAgentPicker,
    readTerminalScreen
  })
  const onCompact = useCallback(async (): Promise<void> => {
    await dispatchCommand(AGENT_COMPACT_COMMAND)
    onCompactionRequested?.()
  }, [dispatchCommand, onCompactionRequested])
  return {
    sessionOptionsSurface: surface,
    sessionOptionsSnapshot: snapshot,
    context,
    canCompact: commands.some((command) => command.name === 'compact'),
    onCompact
  }
}
