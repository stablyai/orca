import { isAgentNeedsInputAlert } from './mobile-push-alert'
import { isAskUserQuestionTool } from './agent-status/lifecycle/agent-question-answered-intent'
import { CODEX_ASYNC_QUESTION_TOOL } from './codex-async-question-input'
import type { NotificationSettings } from './notification-settings-types'

type SourceGateSettings = Pick<
  NotificationSettings,
  'enabled' | 'agentTaskComplete' | 'agentNeedsInput' | 'agentQuestionsOnly' | 'terminalBell'
>

/** The desktop's per-source preferences; paired phones receive an alert only when this allows it. */
export function isNotificationSourceEnabled(
  settings: SourceGateSettings,
  source: string,
  agentState: string | undefined,
  agentToolName?: string
): boolean {
  if (!settings.enabled) {
    return false
  }
  if (settings.agentQuestionsOnly && source !== 'test') {
    return (
      isAgentNeedsInputAlert(source, agentState) &&
      (isAskUserQuestionTool(agentToolName) || agentToolName === CODEX_ASYNC_QUESTION_TOOL)
    )
  }
  if (source === 'terminal-bell') {
    return settings.terminalBell
  }
  if (source !== 'agent-task-complete') {
    return true
  }
  return isAgentNeedsInputAlert(source, agentState)
    ? settings.agentNeedsInput
    : settings.agentTaskComplete
}
