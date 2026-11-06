import { translate } from '@/i18n/i18n'
import {
  AGENT_OUTPUT_FAILURE_COPY as EN,
  type AgentOutputFailureCode
} from '../../../shared/agent-output-failure-copy'

type CopyValues = Record<string, string | number>

// Merged into the text-generation copy table; textGenerationErrorText checks the slot values.
export const AGENT_OUTPUT_ERROR_COPY: Record<
  AgentOutputFailureCode,
  (values: CopyValues) => string
> = {
  openCodeInvalidEvents: (values) =>
    translate(
      'sourceControl.textGeneration.errors.openCodeInvalidEvents',
      EN.openCodeInvalidEvents,
      values
    ),
  antigravityInvalidEvents: (values) =>
    translate(
      'sourceControl.textGeneration.errors.antigravityInvalidEvents',
      EN.antigravityInvalidEvents,
      values
    ),
  antigravityInvalidResult: (values) =>
    translate(
      'sourceControl.textGeneration.errors.antigravityInvalidResult',
      EN.antigravityInvalidResult,
      values
    ),
  antigravityNoFinalResult: (values) =>
    translate(
      'sourceControl.textGeneration.errors.antigravityNoFinalResult',
      EN.antigravityNoFinalResult,
      values
    ),
  kimiUnreadableOutput: (values) =>
    translate(
      'sourceControl.textGeneration.errors.kimiUnreadableOutput',
      EN.kimiUnreadableOutput,
      values
    ),
  kimiSessionOccupied: (values) =>
    translate(
      'sourceControl.textGeneration.errors.kimiSessionOccupied',
      EN.kimiSessionOccupied,
      values
    ),
  kimiInterrupted: (values) =>
    translate('sourceControl.textGeneration.errors.kimiInterrupted', EN.kimiInterrupted, values),
  kimiFailed: (values) =>
    translate('sourceControl.textGeneration.errors.kimiFailed', EN.kimiFailed, values),
  kimiAgentOptionsConflict: (values) =>
    translate(
      'sourceControl.textGeneration.errors.kimiAgentOptionsConflict',
      EN.kimiAgentOptionsConflict,
      values
    ),
  kimiOptionRejected: (values) =>
    translate(
      'sourceControl.textGeneration.errors.kimiOptionRejected',
      EN.kimiOptionRejected,
      values
    ),
  kimiSessionNotFound: (values) =>
    translate(
      'sourceControl.textGeneration.errors.kimiSessionNotFound',
      EN.kimiSessionNotFound,
      values
    ),
  kimiSessionOtherDirectory: (values) =>
    translate(
      'sourceControl.textGeneration.errors.kimiSessionOtherDirectory',
      EN.kimiSessionOtherDirectory,
      values
    ),
  kimiCredentialVariableMissing: (values) =>
    translate(
      'sourceControl.textGeneration.errors.kimiCredentialVariableMissing',
      EN.kimiCredentialVariableMissing,
      values
    ),
  kimiCredentialsRequired: (values) =>
    translate(
      'sourceControl.textGeneration.errors.kimiCredentialsRequired',
      EN.kimiCredentialsRequired,
      values
    ),
  kimiModelMissing: (values) =>
    translate('sourceControl.textGeneration.errors.kimiModelMissing', EN.kimiModelMissing, values),
  kimiPromptHookBlocked: (values) =>
    translate(
      'sourceControl.textGeneration.errors.kimiPromptHookBlocked',
      EN.kimiPromptHookBlocked,
      values
    ),
  kimiCancelled: (values) =>
    translate('sourceControl.textGeneration.errors.kimiCancelled', EN.kimiCancelled, values),
  kimiEmptyPrompt: (values) =>
    translate('sourceControl.textGeneration.errors.kimiEmptyPrompt', EN.kimiEmptyPrompt, values),
  kimiEmptyModel: (values) =>
    translate('sourceControl.textGeneration.errors.kimiEmptyModel', EN.kimiEmptyModel, values),
  kimiEmptyAgent: (values) =>
    translate('sourceControl.textGeneration.errors.kimiEmptyAgent', EN.kimiEmptyAgent, values),
  kimiEmptyAgentFilePath: (values) =>
    translate(
      'sourceControl.textGeneration.errors.kimiEmptyAgentFilePath',
      EN.kimiEmptyAgentFilePath,
      values
    ),
  kimiOutputFormatInvalid: (values) =>
    translate(
      'sourceControl.textGeneration.errors.kimiOutputFormatInvalid',
      EN.kimiOutputFormatInvalid,
      values
    ),
  kimiSessionIdRequired: (values) =>
    translate(
      'sourceControl.textGeneration.errors.kimiSessionIdRequired',
      EN.kimiSessionIdRequired,
      values
    ),
  kimiConflictingOptions: (values) =>
    translate(
      'sourceControl.textGeneration.errors.kimiConflictingOptions',
      EN.kimiConflictingOptions,
      values
    ),
  kimiContinueSessionConflict: (values) =>
    translate(
      'sourceControl.textGeneration.errors.kimiContinueSessionConflict',
      EN.kimiContinueSessionConflict,
      values
    ),
  kimiAgentChangeOnResume: (values) =>
    translate(
      'sourceControl.textGeneration.errors.kimiAgentChangeOnResume',
      EN.kimiAgentChangeOnResume,
      values
    ),
  kimiResponseBlocked: (values) =>
    translate(
      'sourceControl.textGeneration.errors.kimiResponseBlocked',
      EN.kimiResponseBlocked,
      values
    ),
  kimiAuthFailed: (values) =>
    translate('sourceControl.textGeneration.errors.kimiAuthFailed', EN.kimiAuthFailed, values),
  kimiConnectionFailed: (values) =>
    translate(
      'sourceControl.textGeneration.errors.kimiConnectionFailed',
      EN.kimiConnectionFailed,
      values
    ),
  kimiProviderLimited: (values) =>
    translate(
      'sourceControl.textGeneration.errors.kimiProviderLimited',
      EN.kimiProviderLimited,
      values
    ),
  kimiContextOverflow: (values) =>
    translate(
      'sourceControl.textGeneration.errors.kimiContextOverflow',
      EN.kimiContextOverflow,
      values
    ),
  kimiConfigInvalid: (values) =>
    translate('sourceControl.textGeneration.errors.kimiConfigInvalid', EN.kimiConfigInvalid, values)
}
