import { translate } from '@/i18n/i18n'
import {
  TEXT_GENERATION_FAILURE_COPY as EN,
  type TextGenerationFailureCode
} from '../../../shared/text-generation-failure-copy'

type CopyValues = Record<string, string | number>

type TextActionRecipeFailureCode = Extract<
  TextGenerationFailureCode,
  | 'commandTemplateEmptyCommitMessage'
  | 'commandTemplateEmptyPullRequest'
  | 'commandTemplateEmptyBranchName'
  | 'commandTemplateEmptyChatName'
  | 'sourceControlAgentUnsupported'
  | 'chatNameAgentUnsupported'
  | 'sourceControlCustomCommandEmpty'
  | 'chatNameCustomCommandEmpty'
  | 'agentCannotGenerateCommitMessage'
  | 'agentCannotGeneratePullRequest'
  | 'agentCannotGenerateBranchName'
  | 'agentCannotGenerateChatName'
>

// Recipe misconfiguration copy, merged into the text-generation copy table.
export const TEXT_ACTION_RECIPE_ERROR_COPY: Record<
  TextActionRecipeFailureCode,
  (values: CopyValues) => string
> = {
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
    )
}
