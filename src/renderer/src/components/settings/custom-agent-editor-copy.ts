// Localized, secret-safe copy for the custom-agent editor. Every message names a
// field and a reason without ever echoing the offending value, key, or path, so
// diagnostics stay safe to render and log. It maps both local validator issues
// and host mutation-failure codes to the same message vocabulary.

import { translate } from '@/i18n/i18n'
import type { AgentCatalogMutationResult } from '../../../../shared/agent-catalog-snapshot'
import {
  isBuiltInAgentLabelKey,
  normalizeAgentLabelKey,
  type AgentFieldIssue
} from '../../../../shared/custom-tui-agent-fields'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../shared/tui-agent-display-names'
import {
  agentAuthoringWriteFailureMessage,
  asAgentAuthoringWriteFailure
} from './agent-authoring-write-failure'
import { agentCatalogSchemaTooNewMessage } from './agent-catalog-schema-too-new'
import type { CustomAgentMutationFocus as EditorFocus } from './custom-agent-editor-state'

type EditorField = 'label' | 'commandOverride' | 'args' | 'env'

/** One resolved, focus-linked error the dialog renders on a control and in the
 *  error summary. `envEntryIndex` targets a specific environment row. */
export type CustomAgentEditorFieldError = {
  field: EditorField
  envEntryIndex?: number
  message: string
}

/** A form-level failure (revision conflict, oversize payload) with no single
 *  offending control; rendered as a banner rather than a field error. */
export type CustomAgentEditorFormError = { message: string }

/** Find the error for a control. An env error without an index applies to the
 *  whole environment section (row count / total-size failures); an indexed error
 *  matches that specific row. */
export function findFieldError(
  errors: readonly CustomAgentEditorFieldError[],
  field: EditorField,
  envEntryIndex?: number
): CustomAgentEditorFieldError | undefined {
  return errors.find((error) => {
    if (error.field !== field) {
      return false
    }
    if (field !== 'env') {
      return true
    }
    return error.envEntryIndex === envEntryIndex
  })
}

export function agentEditorFieldLabel(field: EditorField): string {
  switch (field) {
    case 'label':
      return translate('auto.components.settings.CustomAgentEditorDialog.fieldLabelName', 'Name')
    case 'commandOverride':
      return translate(
        'auto.components.settings.CustomAgentEditorDialog.fieldLabelExecutable',
        'Executable'
      )
    case 'args':
      return translate(
        'auto.components.settings.CustomAgentEditorDialog.fieldLabelArguments',
        'Arguments'
      )
    case 'env':
      return translate(
        'auto.components.settings.CustomAgentEditorDialog.fieldLabelEnv',
        'Environment variables'
      )
  }
}

// Reason messages are grouped per field so each reads naturally in place; a
// shared fallback covers host-only reasons the editor cannot itself produce.
function describeFieldReason(field: EditorField, reason: string): string {
  const specific = fieldSpecificReason(field, reason)
  return specific ?? invalidValueFallback()
}

// `string`, not AgentFieldIssueReason: host-only reasons reach here too.
function fieldSpecificReason(field: EditorField, reason: string): string | null {
  switch (field) {
    case 'label':
      return labelReason(reason)
    case 'commandOverride':
      return commandReason(reason)
    case 'args':
      return argsReason(reason)
    case 'env':
      return envReason(reason)
  }
}

function labelReason(reason: string): string | null {
  if (reason === 'empty') {
    return translate(
      'auto.components.settings.CustomAgentEditorDialog.labelEmpty',
      'Enter a name for this agent.'
    )
  }
  if (reason === 'bounds') {
    return translate(
      'auto.components.settings.CustomAgentEditorDialog.labelBounds',
      'Use 80 characters or fewer.'
    )
  }
  return null
}

function commandReason(reason: string): string | null {
  switch (reason) {
    case 'empty':
      return translate(
        'auto.components.settings.CustomAgentEditorDialog.commandEmpty',
        'Enter a valid executable path, or leave this blank.'
      )
    case 'bounds':
      return translate(
        'auto.components.settings.CustomAgentEditorDialog.commandBounds',
        'Use 4096 characters or fewer.'
      )
    case 'control_char':
      return translate(
        'auto.components.settings.CustomAgentEditorDialog.commandControlChar',
        'Remove control characters from the executable path.'
      )
    case 'unterminated_quote':
      return translate(
        'auto.components.settings.CustomAgentEditorDialog.commandQuote',
        'Balance the quotes in the executable path.'
      )
    case 'shell_operator':
      return translate(
        'auto.components.settings.CustomAgentEditorDialog.commandShellOperator',
        'This looks like a shell command. Put command lists or pipelines in Quick Commands.'
      )
    default:
      return null
  }
}

function argsReason(reason: string): string | null {
  switch (reason) {
    case 'bounds':
      return translate(
        'auto.components.settings.CustomAgentEditorDialog.argsBounds',
        'Use 8192 characters or fewer.'
      )
    case 'control_char':
      return translate(
        'auto.components.settings.CustomAgentEditorDialog.argsControlChar',
        'Remove the unsupported control character.'
      )
    case 'unterminated_quote':
      return translate(
        'auto.components.settings.CustomAgentEditorDialog.argsQuote',
        'Balance the quotes in the arguments.'
      )
    case 'quoted_line_break':
      return translate(
        'auto.components.settings.CustomAgentEditorDialog.argsQuotedLineBreak',
        "A quoted argument can't span multiple lines."
      )
    default:
      return null
  }
}

function envReason(reason: string): string | null {
  switch (reason) {
    case 'bounds':
      return translate(
        'auto.components.settings.CustomAgentEditorDialog.envBounds',
        'Check this variable against the name and value limits.'
      )
    case 'reserved_name':
      return translate(
        'auto.components.settings.CustomAgentEditorDialog.envReserved',
        'Names starting with ORCA_ are reserved.'
      )
    case 'prototype_key':
      return translate(
        'auto.components.settings.CustomAgentEditorDialog.envPrototype',
        "This variable name isn't allowed."
      )
    case 'case_collision':
      return translate(
        'auto.components.settings.CustomAgentEditorDialog.envCaseCollision',
        'Another variable already uses this name.'
      )
    case 'control_char':
      return translate(
        'auto.components.settings.CustomAgentEditorDialog.envControlChar',
        "Values can't contain line breaks or null characters."
      )
    case 'env_total_bounds':
      return translate(
        'auto.components.settings.CustomAgentEditorDialog.envTotalBounds',
        'Environment variables exceed the 16 KiB limit.'
      )
    default:
      return null
  }
}

function invalidValueFallback(): string {
  return translate(
    'auto.components.settings.CustomAgentEditorDialog.invalidValue',
    "This value isn't valid."
  )
}

export function describeAgentFieldIssue(
  issue: AgentFieldIssue
): CustomAgentEditorFieldError | null {
  // The editor only surfaces the four editable fields; identity/baseAgent issues
  // belong to the repair flow, not this dialog.
  if (
    issue.field !== 'label' &&
    issue.field !== 'commandOverride' &&
    issue.field !== 'args' &&
    issue.field !== 'env'
  ) {
    return null
  }
  return {
    field: issue.field,
    envEntryIndex: issue.envEntryIndex,
    message: describeFieldReason(issue.field, issue.reason)
  }
}

/** A name that exactly matches a built-in canonical product name is reserved.
 *  This is a static, local check so the dialog can explain it before submit. */
export function reservedBuiltInLabelError(label: string): CustomAgentEditorFieldError | null {
  const key = normalizeAgentLabelKey(label)
  if (key.length === 0 || !isBuiltInAgentLabelKey(key)) {
    return null
  }
  const harness =
    Object.values(TUI_AGENT_DISPLAY_NAMES).find((name) => normalizeAgentLabelKey(name) === key) ??
    label
  return {
    field: 'label',
    message: translate(
      'auto.components.settings.CustomAgentEditorDialog.labelReservedBuiltIn',
      'That name is reserved for the built-in {{harness}} agent.',
      { harness }
    )
  }
}

export type CustomAgentMutationFailureCopy =
  | { scope: 'field'; error: CustomAgentEditorFieldError; focus: EditorFocus }
  | { scope: 'form'; error: CustomAgentEditorFormError }

/** Map a host rejection to either a field error (focus a control, keep the draft)
 *  or a form-level banner. Revision conflicts and oversize payloads are form-level
 *  so the dialog keeps every field and asks the user to review and retry. */
export function describeMutationFailure(
  result: Extract<AgentCatalogMutationResult, { ok: false }>,
  focus: EditorFocus | null
): CustomAgentMutationFailureCopy {
  if (result.code === 'duplicate_agent_label') {
    return {
      scope: 'field',
      focus: { field: 'label' },
      error: {
        field: 'label',
        message: translate(
          'auto.components.settings.CustomAgentEditorDialog.labelInUse',
          'That name is already in use. Choose a different name.'
        )
      }
    }
  }
  if (result.code === 'invalid_agent_field' && focus) {
    return {
      scope: 'field',
      focus,
      error: {
        field: focus.field,
        envEntryIndex: focus.envEntryIndex,
        message: describeFieldReason(focus.field, result.reason ?? 'bounds')
      }
    }
  }
  // Distinct from the generic fallback: the draft is intact but unsaved, so the
  // banner must say retry rather than let the user assume it persisted.
  if (asAgentAuthoringWriteFailure(result)) {
    return { scope: 'form', error: { message: agentAuthoringWriteFailureMessage() } }
  }
  // No retry affordance: only updating Orca clears a too-new profile schema.
  if (result.code === 'agent_catalog_schema_too_new') {
    return { scope: 'form', error: { message: agentCatalogSchemaTooNewMessage() } }
  }
  if (result.code === 'catalog_revision_conflict') {
    return {
      scope: 'form',
      error: {
        message: translate(
          'auto.components.settings.CustomAgentEditorDialog.revisionConflict',
          'These settings changed while you were editing. Review your changes and try again.'
        )
      }
    }
  }
  if (
    result.code === 'agent_catalog_local_payload_too_large' ||
    result.code === 'agent_catalog_payload_too_large'
  ) {
    return {
      scope: 'form',
      error: {
        message: translate(
          'auto.components.settings.CustomAgentEditorDialog.payloadTooLarge',
          'This configuration is too large to save. Remove some arguments or environment variables.'
        )
      }
    }
  }
  return {
    scope: 'form',
    error: {
      message: translate(
        'auto.components.settings.CustomAgentEditorDialog.reloadAndRetry',
        'Reload settings and try again.'
      )
    }
  }
}
