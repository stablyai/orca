import { translate } from '@/i18n/i18n'
import {
  TEXT_GENERATION_FAILURE_COPY,
  type TextGenerationFailureCode
} from '../../../../shared/text-generation-failure-copy'
import { AGENT_OUTPUT_ERROR_COPY } from './agent-output-error-copy'
import { ON_DEVICE_ERROR_COPY } from './on-device-error-copy'

export type TextGenerationCopyValues = Record<string, string | number>

export const TEXT_GENERATION_ERROR_COPY: Record<
  TextGenerationFailureCode,
  (values: TextGenerationCopyValues) => string
> = {
  promptTooLargeForWindows: (values) =>
    translate(
      'sourceControl.textGeneration.errors.promptTooLargeForWindows',
      TEXT_GENERATION_FAILURE_COPY.promptTooLargeForWindows,
      values
    ),
  promptTooLargeForArgument: (values) =>
    translate(
      'sourceControl.textGeneration.errors.promptTooLargeForArgument',
      TEXT_GENERATION_FAILURE_COPY.promptTooLargeForArgument,
      values
    ),
  agentCouldNotStart: (values) =>
    translate(
      'sourceControl.textGeneration.errors.agentCouldNotStart',
      TEXT_GENERATION_FAILURE_COPY.agentCouldNotStart,
      values
    ),
  agentFailedToStart: (values) =>
    translate(
      'sourceControl.textGeneration.errors.agentFailedToStart',
      TEXT_GENERATION_FAILURE_COPY.agentFailedToStart,
      values
    ),
  agentBinaryNotFound: (values) =>
    translate(
      'sourceControl.textGeneration.errors.agentBinaryNotFound',
      TEXT_GENERATION_FAILURE_COPY.agentBinaryNotFound,
      values
    ),
  timedOut: (values) =>
    translate(
      'sourceControl.textGeneration.errors.timedOut',
      TEXT_GENERATION_FAILURE_COPY.timedOut,
      values
    ),
  outputTooLarge: (values) =>
    translate(
      'sourceControl.textGeneration.errors.outputTooLarge',
      TEXT_GENERATION_FAILURE_COPY.outputTooLarge,
      values
    ),
  windowsBatchUnsafeArguments: (values) =>
    translate(
      'sourceControl.textGeneration.errors.windowsBatchUnsafeArguments',
      TEXT_GENERATION_FAILURE_COPY.windowsBatchUnsafeArguments,
      values
    ),
  cliTerminated: (values) =>
    translate(
      'sourceControl.textGeneration.errors.cliTerminated',
      TEXT_GENERATION_FAILURE_COPY.cliTerminated,
      values
    ),
  cliTerminatedWithDetail: (values) =>
    translate(
      'sourceControl.textGeneration.errors.cliTerminatedWithDetail',
      TEXT_GENERATION_FAILURE_COPY.cliTerminatedWithDetail,
      values
    ),
  cliFailed: (values) =>
    translate(
      'sourceControl.textGeneration.errors.cliFailed',
      TEXT_GENERATION_FAILURE_COPY.cliFailed,
      values
    ),
  cliFailedWithDetail: (values) =>
    translate(
      'sourceControl.textGeneration.errors.cliFailedWithDetail',
      TEXT_GENERATION_FAILURE_COPY.cliFailedWithDetail,
      values
    ),
  agentReportedError: (values) =>
    translate(
      'sourceControl.textGeneration.errors.agentReportedError',
      TEXT_GENERATION_FAILURE_COPY.agentReportedError,
      values
    ),
  emptyCommitMessage: (values) =>
    translate(
      'sourceControl.textGeneration.errors.emptyCommitMessage',
      TEXT_GENERATION_FAILURE_COPY.emptyCommitMessage,
      values
    ),
  emptyCommitMessageWithDetail: (values) =>
    translate(
      'sourceControl.textGeneration.errors.emptyCommitMessageWithDetail',
      TEXT_GENERATION_FAILURE_COPY.emptyCommitMessageWithDetail,
      values
    ),
  emptyPullRequestDetails: (values) =>
    translate(
      'sourceControl.textGeneration.errors.emptyPullRequestDetails',
      TEXT_GENERATION_FAILURE_COPY.emptyPullRequestDetails,
      values
    ),
  emptyPullRequestDetailsWithDetail: (values) =>
    translate(
      'sourceControl.textGeneration.errors.emptyPullRequestDetailsWithDetail',
      TEXT_GENERATION_FAILURE_COPY.emptyPullRequestDetailsWithDetail,
      values
    ),
  emptyJiraSummary: (values) =>
    translate(
      'sourceControl.textGeneration.errors.emptyJiraSummary',
      TEXT_GENERATION_FAILURE_COPY.emptyJiraSummary,
      values
    ),
  emptyJiraSummaryWithDetail: (values) =>
    translate(
      'sourceControl.textGeneration.errors.emptyJiraSummaryWithDetail',
      TEXT_GENERATION_FAILURE_COPY.emptyJiraSummaryWithDetail,
      values
    ),
  commitMessageUnparseable: (values) =>
    translate(
      'sourceControl.textGeneration.errors.commitMessageUnparseable',
      TEXT_GENERATION_FAILURE_COPY.commitMessageUnparseable,
      values
    ),
  pullRequestDetailsUnparseable: (values) =>
    translate(
      'sourceControl.textGeneration.errors.pullRequestDetailsUnparseable',
      TEXT_GENERATION_FAILURE_COPY.pullRequestDetailsUnparseable,
      values
    ),
  jiraSummaryEmptyAfterSanitization: (values) =>
    translate(
      'sourceControl.textGeneration.errors.jiraSummaryEmptyAfterSanitization',
      TEXT_GENERATION_FAILURE_COPY.jiraSummaryEmptyAfterSanitization,
      values
    ),
  jiraDescriptionRequired: (values) =>
    translate(
      'sourceControl.textGeneration.errors.jiraDescriptionRequired',
      TEXT_GENERATION_FAILURE_COPY.jiraDescriptionRequired,
      values
    ),
  jiraAccountDisconnected: (values) =>
    translate(
      'sourceControl.textGeneration.errors.jiraAccountDisconnected',
      TEXT_GENERATION_FAILURE_COPY.jiraAccountDisconnected,
      values
    ),
  jiraSummaryBusyInOtherDraft: (values) =>
    translate(
      'sourceControl.textGeneration.errors.jiraSummaryBusyInOtherDraft',
      TEXT_GENERATION_FAILURE_COPY.jiraSummaryBusyInOtherDraft,
      values
    ),
  stagedChangesReadFailed: (values) =>
    translate(
      'sourceControl.textGeneration.errors.stagedChangesReadFailed',
      TEXT_GENERATION_FAILURE_COPY.stagedChangesReadFailed,
      values
    ),
  noStagedChanges: (values) =>
    translate(
      'sourceControl.textGeneration.errors.noStagedChanges',
      TEXT_GENERATION_FAILURE_COPY.noStagedChanges,
      values
    ),
  noBranchChanges: (values) =>
    translate(
      'sourceControl.textGeneration.errors.noBranchChanges',
      TEXT_GENERATION_FAILURE_COPY.noBranchChanges,
      values
    ),
  commandTemplateEmptyCommitMessage: (values) =>
    translate(
      'sourceControl.textGeneration.errors.commandTemplateEmptyCommitMessage',
      TEXT_GENERATION_FAILURE_COPY.commandTemplateEmptyCommitMessage,
      values
    ),
  commandTemplateEmptyPullRequest: (values) =>
    translate(
      'sourceControl.textGeneration.errors.commandTemplateEmptyPullRequest',
      TEXT_GENERATION_FAILURE_COPY.commandTemplateEmptyPullRequest,
      values
    ),
  commandTemplateEmptyBranchName: (values) =>
    translate(
      'sourceControl.textGeneration.errors.commandTemplateEmptyBranchName',
      TEXT_GENERATION_FAILURE_COPY.commandTemplateEmptyBranchName,
      values
    ),
  commandTemplateEmptyChatName: (values) =>
    translate(
      'sourceControl.textGeneration.errors.commandTemplateEmptyChatName',
      TEXT_GENERATION_FAILURE_COPY.commandTemplateEmptyChatName,
      values
    ),
  sourceControlAgentUnsupported: (values) =>
    translate(
      'sourceControl.textGeneration.errors.sourceControlAgentUnsupported',
      TEXT_GENERATION_FAILURE_COPY.sourceControlAgentUnsupported,
      values
    ),
  chatNameAgentUnsupported: (values) =>
    translate(
      'sourceControl.textGeneration.errors.chatNameAgentUnsupported',
      TEXT_GENERATION_FAILURE_COPY.chatNameAgentUnsupported,
      values
    ),
  sourceControlCustomCommandEmpty: (values) =>
    translate(
      'sourceControl.textGeneration.errors.sourceControlCustomCommandEmpty',
      TEXT_GENERATION_FAILURE_COPY.sourceControlCustomCommandEmpty,
      values
    ),
  chatNameCustomCommandEmpty: (values) =>
    translate(
      'sourceControl.textGeneration.errors.chatNameCustomCommandEmpty',
      TEXT_GENERATION_FAILURE_COPY.chatNameCustomCommandEmpty,
      values
    ),
  agentCannotGenerateCommitMessage: (values) =>
    translate(
      'sourceControl.textGeneration.errors.agentCannotGenerateCommitMessage',
      TEXT_GENERATION_FAILURE_COPY.agentCannotGenerateCommitMessage,
      values
    ),
  agentCannotGeneratePullRequest: (values) =>
    translate(
      'sourceControl.textGeneration.errors.agentCannotGeneratePullRequest',
      TEXT_GENERATION_FAILURE_COPY.agentCannotGeneratePullRequest,
      values
    ),
  agentCannotGenerateBranchName: (values) =>
    translate(
      'sourceControl.textGeneration.errors.agentCannotGenerateBranchName',
      TEXT_GENERATION_FAILURE_COPY.agentCannotGenerateBranchName,
      values
    ),
  agentCannotGenerateChatName: (values) =>
    translate(
      'sourceControl.textGeneration.errors.agentCannotGenerateChatName',
      TEXT_GENERATION_FAILURE_COPY.agentCannotGenerateChatName,
      values
    ),
  noModelForAgent: (values) =>
    translate(
      'sourceControl.textGeneration.errors.noModelForAgent',
      TEXT_GENERATION_FAILURE_COPY.noModelForAgent,
      values
    ),
  planCustomCommandEmpty: (values) =>
    translate(
      'sourceControl.textGeneration.errors.planCustomCommandEmpty',
      TEXT_GENERATION_FAILURE_COPY.planCustomCommandEmpty,
      values
    ),
  planAgentUnsupported: (values) =>
    translate(
      'sourceControl.textGeneration.errors.planAgentUnsupported',
      TEXT_GENERATION_FAILURE_COPY.planAgentUnsupported,
      values
    ),
  planModelUnavailable: (values) =>
    translate(
      'sourceControl.textGeneration.errors.planModelUnavailable',
      TEXT_GENERATION_FAILURE_COPY.planModelUnavailable,
      values
    ),
  planModelWithoutThinking: (values) =>
    translate(
      'sourceControl.textGeneration.errors.planModelWithoutThinking',
      TEXT_GENERATION_FAILURE_COPY.planModelWithoutThinking,
      values
    ),
  planThinkingLevelInvalid: (values) =>
    translate(
      'sourceControl.textGeneration.errors.planThinkingLevelInvalid',
      TEXT_GENERATION_FAILURE_COPY.planThinkingLevelInvalid,
      values
    ),
  ...ON_DEVICE_ERROR_COPY,
  ...AGENT_OUTPUT_ERROR_COPY
}
