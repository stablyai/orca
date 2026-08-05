// User-facing text for the no-tools adapter's transport and protocol failures.
//
// SHARED BY BOTH LANES deliberately. The plan and code audits use the same
// transport, so a rate-limit or a malformed response means exactly the same
// thing in each. Two copies would drift, and a user seeing different wording for
// the same condition would reasonably conclude they were different conditions.
//
// NO RAW DETAIL REACHES THESE STRINGS. No HTTP status, no provider message, no
// URL, no header, no path. Every string is selected by a closed code, so there
// is no channel through which a response body could reach the UI.
import type { NoToolsReasonCode } from '../../../../shared/audited-audit-mode-types'

type Translate = (key: string, fallback: string) => string

/**
 * Returns the message for a no-tools code, or null when the code is not one.
 *
 * Returning null rather than throwing lets each lane's switch keep its own
 * exhaustiveness guarantee: the lane still enumerates every code it handles, and
 * this helper only supplies the shared text.
 */
export function translateNoToolsReasonCode(code: NoToolsReasonCode, translate: Translate): string {
  switch (code) {
    case 'api_unauthorized':
      // Must NOT say "not configured" — a key exists, it was just rejected.
      // Sending the user to configure something they configured is the circular
      // advice credential_delivery_unavailable's wording already avoids.
      return translate(
        'auto.components.auditedWorkflow.errors.noToolsApiUnauthorized',
        'The reviewer rejected the stored API key. Check the key and try again.'
      )
    case 'api_rate_limited':
      return translate(
        'auto.components.auditedWorkflow.errors.noToolsApiRateLimited',
        'The reviewer is rate limited right now. Wait a moment and retry.'
      )
    case 'api_unavailable':
      return translate(
        'auto.components.auditedWorkflow.errors.noToolsApiUnavailable',
        'The reviewer could not be reached. Check your connection and retry.'
      )
    case 'api_timeout':
      return translate(
        'auto.components.auditedWorkflow.errors.noToolsApiTimeout',
        'The reviewer did not respond in time, so no result was recorded.'
      )
    case 'response_malformed':
      return translate(
        'auto.components.auditedWorkflow.errors.noToolsResponseMalformed',
        'The reviewer returned a response Orca could not read, so nothing was approved.'
      )
    case 'context_limit_exceeded':
      return translate(
        'auto.components.auditedWorkflow.errors.noToolsContextLimit',
        'This change is too large for the reviewer to read in one pass.'
      )
    case 'bundle_too_large':
      // "Nothing was sent" is the load-bearing half: the user should know their
      // code did not leave the machine.
      return translate(
        'auto.components.auditedWorkflow.errors.noToolsBundleTooLarge',
        'This change is too large to review, so nothing was sent.'
      )
    case 'redaction_failed':
      return translate(
        'auto.components.auditedWorkflow.errors.noToolsRedactionFailed',
        'Orca could not safely redact this change, so nothing was sent.'
      )
    case 'context_request_invalid':
      // Deliberately vague about WHICH path was refused: naming it would echo a
      // model-supplied string into the UI and turn refusals into a map of the
      // filesystem.
      return translate(
        'auto.components.auditedWorkflow.errors.noToolsContextRequestInvalid',
        'The reviewer asked for files outside the reviewed work, so the audit was stopped.'
      )
    case 'context_budget_exhausted':
      return translate(
        'auto.components.auditedWorkflow.errors.noToolsContextBudgetExhausted',
        'The reviewer needed more context than this mode allows, so no verdict was recorded.'
      )
  }
}

/** The codes this helper covers, for each lane's switch to delegate on. */
export const NO_TOOLS_MESSAGE_CODES = new Set<string>([
  'api_unauthorized',
  'api_rate_limited',
  'api_unavailable',
  'api_timeout',
  'response_malformed',
  'context_limit_exceeded',
  'bundle_too_large',
  'redaction_failed',
  'context_request_invalid',
  'context_budget_exhausted'
])
