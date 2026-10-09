import { translate } from '@/i18n/i18n'
import {
  AGENT_SESSION_FAILURE_COPY as COPY,
  type AgentSessionFailureCopyId,
  type AgentSessionFailureCopyValues
} from '../../../../shared/agent-session-failure-copy'

type CommandCopyId = Extract<AgentSessionFailureCopyId, `command${string}`>

export const COMMAND_REFUSAL_PIECES: Record<
  CommandCopyId,
  (values: AgentSessionFailureCopyValues) => string
> = {
  commandAfterAnswer: (values) =>
    translate(
      'components.native-chat.failureWords.commandAfterAnswer',
      COPY.commandAfterAnswer,
      values
    ),
  commandBackgroundTasksRunning: (values) =>
    translate(
      'components.native-chat.failureWords.commandBackgroundTasksRunning',
      COPY.commandBackgroundTasksRunning,
      values
    ),
  commandAfterSending: (values) =>
    translate(
      'components.native-chat.failureWords.commandAfterSending',
      COPY.commandAfterSending,
      values
    ),
  commandWaitForPendingWork: (values) =>
    translate(
      'components.native-chat.failureWords.commandWaitForPendingWork',
      COPY.commandWaitForPendingWork,
      values
    ),
  commandStillWorking: (values) =>
    translate(
      'components.native-chat.failureWords.commandStillWorking',
      COPY.commandStillWorking,
      values
    ),
  commandRefused: (values) =>
    translate('components.native-chat.failureWords.commandRefused', COPY.commandRefused, values),
  commandUnsupported: (values) =>
    translate(
      'components.native-chat.failureWords.commandUnsupported',
      COPY.commandUnsupported,
      values
    ),
  commandAgentStarting: (values) =>
    translate(
      'components.native-chat.failureWords.commandAgentStarting',
      COPY.commandAgentStarting,
      values
    ),
  commandWaitForStart: (values) =>
    translate(
      'components.native-chat.failureWords.commandWaitForStart',
      COPY.commandWaitForStart,
      values
    ),
  commandTurnActive: (values) =>
    translate(
      'components.native-chat.failureWords.commandTurnActive',
      COPY.commandTurnActive,
      values
    ),
  commandWaitForTurn: (values) =>
    translate(
      'components.native-chat.failureWords.commandWaitForTurn',
      COPY.commandWaitForTurn,
      values
    ),
  commandPromptPending: (values) =>
    translate(
      'components.native-chat.failureWords.commandPromptPending',
      COPY.commandPromptPending,
      values
    ),
  commandAgentRefused: (values) =>
    translate(
      'components.native-chat.failureWords.commandAgentRefused',
      COPY.commandAgentRefused,
      values
    ),
  commandOwnerUnproven: (values) =>
    translate(
      'components.native-chat.failureWords.commandOwnerUnproven',
      COPY.commandOwnerUnproven,
      values
    ),
  commandGoalsUnsupported: (values) =>
    translate(
      'components.native-chat.failureWords.commandGoalsUnsupported',
      COPY.commandGoalsUnsupported,
      values
    ),
  commandOptionRejected: (values) =>
    translate(
      'components.native-chat.failureWords.commandOptionRejected',
      COPY.commandOptionRejected,
      values
    )
}
