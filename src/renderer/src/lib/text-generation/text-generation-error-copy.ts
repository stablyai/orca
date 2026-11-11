import '@/i18n/i18n'
import {
  TEXT_GENERATION_FAILURE_COPY,
  type TextGenerationFailureCode
} from '../../../../shared/text-generation-failure-copy'
import './agent-output-error-copy'
import {
  TEXT_GENERATION_ERROR_COPY,
  type TextGenerationCopyValues
} from './text-generation-error-message-catalog'

function isTextGenerationFailureCode(code: unknown): code is TextGenerationFailureCode {
  return typeof code === 'string' && Object.hasOwn(TEXT_GENERATION_ERROR_COPY, code)
}

type TextGenerationFailure = {
  error: string
  errorCode?: unknown
  errorParams?: unknown
  errorDetail?: unknown
}

export function textGenerationCopyText(
  code: TextGenerationFailureCode,
  values: TextGenerationCopyValues = {}
): string {
  return TEXT_GENERATION_ERROR_COPY[code](values)
}

export function textGenerationErrorText(failure: TextGenerationFailure): string {
  if (!isTextGenerationFailureCode(failure.errorCode)) {
    return failure.error
  }
  const params: Record<string, unknown> =
    typeof failure.errorParams === 'object' && failure.errorParams !== null
      ? { ...failure.errorParams }
      : {}
  const values: TextGenerationCopyValues = {}
  for (const [, slot] of TEXT_GENERATION_FAILURE_COPY[failure.errorCode].matchAll(
    /\{\{(\w+)\}\}/g
  )) {
    const value = slot === 'detail' ? failure.errorDetail : params[slot]
    if (typeof value !== 'string' && typeof value !== 'number') {
      return failure.error
    }
    values[slot] = value
  }
  return TEXT_GENERATION_ERROR_COPY[failure.errorCode](values)
}

export function localizeTextGenerationResult<
  T extends { success: true } | ({ success: false } & TextGenerationFailure)
>(result: T): T {
  return result.success ? result : { ...result, error: textGenerationErrorText(result) }
}
