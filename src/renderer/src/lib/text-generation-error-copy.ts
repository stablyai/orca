import { translate } from '@/i18n/i18n'
import {
  TEXT_GENERATION_FAILURE_COPY as EN,
  type TextGenerationFailureCode
} from '../../../shared/text-generation-failure-copy'

type CopyValues = Record<string, string | number>

const COPY: Record<TextGenerationFailureCode, (values: CopyValues) => string> = {
  promptTooLargeForWindows: (values) =>
    translate(
      'sourceControl.textGeneration.errors.promptTooLargeForWindows',
      EN.promptTooLargeForWindows,
      values
    ),
  promptTooLargeForArgument: (values) =>
    translate(
      'sourceControl.textGeneration.errors.promptTooLargeForArgument',
      EN.promptTooLargeForArgument,
      values
    ),
  agentCouldNotStart: (values) =>
    translate(
      'sourceControl.textGeneration.errors.agentCouldNotStart',
      EN.agentCouldNotStart,
      values
    ),
  agentFailedToStart: (values) =>
    translate(
      'sourceControl.textGeneration.errors.agentFailedToStart',
      EN.agentFailedToStart,
      values
    ),
  agentBinaryNotFound: (values) =>
    translate(
      'sourceControl.textGeneration.errors.agentBinaryNotFound',
      EN.agentBinaryNotFound,
      values
    ),
  timedOut: (values) =>
    translate('sourceControl.textGeneration.errors.timedOut', EN.timedOut, values),
  outputTooLarge: (values) =>
    translate('sourceControl.textGeneration.errors.outputTooLarge', EN.outputTooLarge, values),
  windowsBatchUnsafeArguments: (values) =>
    translate(
      'sourceControl.textGeneration.errors.windowsBatchUnsafeArguments',
      EN.windowsBatchUnsafeArguments,
      values
    ),
  cliTerminated: (values) =>
    translate('sourceControl.textGeneration.errors.cliTerminated', EN.cliTerminated, values),
  cliTerminatedWithDetail: (values) =>
    translate(
      'sourceControl.textGeneration.errors.cliTerminatedWithDetail',
      EN.cliTerminatedWithDetail,
      values
    ),
  cliFailed: (values) =>
    translate('sourceControl.textGeneration.errors.cliFailed', EN.cliFailed, values),
  cliFailedWithDetail: (values) =>
    translate(
      'sourceControl.textGeneration.errors.cliFailedWithDetail',
      EN.cliFailedWithDetail,
      values
    ),
  agentReportedError: (values) =>
    translate(
      'sourceControl.textGeneration.errors.agentReportedError',
      EN.agentReportedError,
      values
    ),
  emptyCommitMessage: (values) =>
    translate(
      'sourceControl.textGeneration.errors.emptyCommitMessage',
      EN.emptyCommitMessage,
      values
    ),
  emptyCommitMessageWithDetail: (values) =>
    translate(
      'sourceControl.textGeneration.errors.emptyCommitMessageWithDetail',
      EN.emptyCommitMessageWithDetail,
      values
    ),
  emptyPullRequestDetails: (values) =>
    translate(
      'sourceControl.textGeneration.errors.emptyPullRequestDetails',
      EN.emptyPullRequestDetails,
      values
    ),
  emptyPullRequestDetailsWithDetail: (values) =>
    translate(
      'sourceControl.textGeneration.errors.emptyPullRequestDetailsWithDetail',
      EN.emptyPullRequestDetailsWithDetail,
      values
    ),
  emptyJiraSummary: (values) =>
    translate('sourceControl.textGeneration.errors.emptyJiraSummary', EN.emptyJiraSummary, values),
  emptyJiraSummaryWithDetail: (values) =>
    translate(
      'sourceControl.textGeneration.errors.emptyJiraSummaryWithDetail',
      EN.emptyJiraSummaryWithDetail,
      values
    ),
  commitMessageUnparseable: (values) =>
    translate(
      'sourceControl.textGeneration.errors.commitMessageUnparseable',
      EN.commitMessageUnparseable,
      values
    ),
  pullRequestDetailsUnparseable: (values) =>
    translate(
      'sourceControl.textGeneration.errors.pullRequestDetailsUnparseable',
      EN.pullRequestDetailsUnparseable,
      values
    ),
  jiraSummaryEmptyAfterSanitization: (values) =>
    translate(
      'sourceControl.textGeneration.errors.jiraSummaryEmptyAfterSanitization',
      EN.jiraSummaryEmptyAfterSanitization,
      values
    ),
  jiraDescriptionRequired: (values) =>
    translate(
      'sourceControl.textGeneration.errors.jiraDescriptionRequired',
      EN.jiraDescriptionRequired,
      values
    ),
  jiraAccountDisconnected: (values) =>
    translate(
      'sourceControl.textGeneration.errors.jiraAccountDisconnected',
      EN.jiraAccountDisconnected,
      values
    ),
  jiraSummaryBusyInOtherDraft: (values) =>
    translate(
      'sourceControl.textGeneration.errors.jiraSummaryBusyInOtherDraft',
      EN.jiraSummaryBusyInOtherDraft,
      values
    ),
  stagedChangesReadFailed: (values) =>
    translate(
      'sourceControl.textGeneration.errors.stagedChangesReadFailed',
      EN.stagedChangesReadFailed,
      values
    ),
  noStagedChanges: (values) =>
    translate('sourceControl.textGeneration.errors.noStagedChanges', EN.noStagedChanges, values),
  noBranchChanges: (values) =>
    translate('sourceControl.textGeneration.errors.noBranchChanges', EN.noBranchChanges, values),
  commandTemplateEmptyCommitMessage: (values) =>
    translate(
      'sourceControl.textGeneration.errors.commandTemplateEmptyCommitMessage',
      EN.commandTemplateEmptyCommitMessage,
      values
    ),
  commandTemplateEmptyPullRequest: (values) =>
    translate(
      'sourceControl.textGeneration.errors.commandTemplateEmptyPullRequest',
      EN.commandTemplateEmptyPullRequest,
      values
    ),
  commandTemplateEmptyBranchName: (values) =>
    translate(
      'sourceControl.textGeneration.errors.commandTemplateEmptyBranchName',
      EN.commandTemplateEmptyBranchName,
      values
    ),
  commandTemplateEmptyChatName: (values) =>
    translate(
      'sourceControl.textGeneration.errors.commandTemplateEmptyChatName',
      EN.commandTemplateEmptyChatName,
      values
    ),
  sourceControlAgentUnsupported: (values) =>
    translate(
      'sourceControl.textGeneration.errors.sourceControlAgentUnsupported',
      EN.sourceControlAgentUnsupported,
      values
    ),
  chatNameAgentUnsupported: (values) =>
    translate(
      'sourceControl.textGeneration.errors.chatNameAgentUnsupported',
      EN.chatNameAgentUnsupported,
      values
    ),
  sourceControlCustomCommandEmpty: (values) =>
    translate(
      'sourceControl.textGeneration.errors.sourceControlCustomCommandEmpty',
      EN.sourceControlCustomCommandEmpty,
      values
    ),
  chatNameCustomCommandEmpty: (values) =>
    translate(
      'sourceControl.textGeneration.errors.chatNameCustomCommandEmpty',
      EN.chatNameCustomCommandEmpty,
      values
    ),
  agentCannotGenerateCommitMessage: (values) =>
    translate(
      'sourceControl.textGeneration.errors.agentCannotGenerateCommitMessage',
      EN.agentCannotGenerateCommitMessage,
      values
    ),
  agentCannotGeneratePullRequest: (values) =>
    translate(
      'sourceControl.textGeneration.errors.agentCannotGeneratePullRequest',
      EN.agentCannotGeneratePullRequest,
      values
    ),
  agentCannotGenerateBranchName: (values) =>
    translate(
      'sourceControl.textGeneration.errors.agentCannotGenerateBranchName',
      EN.agentCannotGenerateBranchName,
      values
    ),
  agentCannotGenerateChatName: (values) =>
    translate(
      'sourceControl.textGeneration.errors.agentCannotGenerateChatName',
      EN.agentCannotGenerateChatName,
      values
    ),
  noModelForAgent: (values) =>
    translate('sourceControl.textGeneration.errors.noModelForAgent', EN.noModelForAgent, values),
  planCustomCommandEmpty: (values) =>
    translate(
      'sourceControl.textGeneration.errors.planCustomCommandEmpty',
      EN.planCustomCommandEmpty,
      values
    ),
  planAgentUnsupported: (values) =>
    translate(
      'sourceControl.textGeneration.errors.planAgentUnsupported',
      EN.planAgentUnsupported,
      values
    ),
  planModelUnavailable: (values) =>
    translate(
      'sourceControl.textGeneration.errors.planModelUnavailable',
      EN.planModelUnavailable,
      values
    ),
  planModelWithoutThinking: (values) =>
    translate(
      'sourceControl.textGeneration.errors.planModelWithoutThinking',
      EN.planModelWithoutThinking,
      values
    ),
  planThinkingLevelInvalid: (values) =>
    translate(
      'sourceControl.textGeneration.errors.planThinkingLevelInvalid',
      EN.planThinkingLevelInvalid,
      values
    )
}

function isTextGenerationFailureCode(code: unknown): code is TextGenerationFailureCode {
  return typeof code === 'string' && Object.hasOwn(COPY, code)
}

type TextGenerationFailure = {
  error: string
  errorCode?: unknown
  errorParams?: unknown
  errorDetail?: unknown
}

/** Localized copy for a failure the renderer detects itself. */
export function textGenerationCopyText(
  code: TextGenerationFailureCode,
  values: CopyValues = {}
): string {
  return COPY[code](values)
}

/** Unknown codes (newer host), uncoded results (older host), or missing values show the host's English. */
export function textGenerationErrorText(failure: TextGenerationFailure): string {
  if (!isTextGenerationFailureCode(failure.errorCode)) {
    return failure.error
  }
  const params: Record<string, unknown> =
    typeof failure.errorParams === 'object' && failure.errorParams !== null
      ? { ...failure.errorParams }
      : {}
  const values: CopyValues = {}
  for (const [, slot] of EN[failure.errorCode].matchAll(/\{\{(\w+)\}\}/g)) {
    const value = slot === 'detail' ? failure.errorDetail : params[slot]
    if (typeof value !== 'string' && typeof value !== 'number') {
      return failure.error
    }
    values[slot] = value
  }
  return COPY[failure.errorCode](values)
}

/** Replaces a failed generation result's English `error` with the localized sentence. */
export function localizeTextGenerationResult<
  T extends { success: true } | ({ success: false } & TextGenerationFailure)
>(result: T): T {
  return result.success ? result : { ...result, error: textGenerationErrorText(result) }
}
