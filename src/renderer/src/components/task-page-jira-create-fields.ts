import { buildJiraCreateTextAdf } from '@/components/jira-create-adf'
import type { JiraCreateField } from '../../../shared/jira-types'

const JIRA_CREATE_SYSTEM_FIELD_KEYS = new Set(['project', 'issuetype', 'summary', 'description'])

/** Jira's own create screen defaults only this field to the authenticated user. */
export const JIRA_REPORTER_FIELD_KEY = 'reporter'

/** True for required create fields the dialog must render (system fields excluded). */
export function isVisibleJiraCreateField(field: JiraCreateField): boolean {
  return field.required && !JIRA_CREATE_SYSTEM_FIELD_KEYS.has(field.key)
}

/**
 * True for any user-typed field, scalar or array. User pickers carry no
 * allowedValues, so schema type is the only way to tell them from free text.
 */
export function isJiraUserCreateField(field: JiraCreateField): boolean {
  return (
    field.schema?.type === 'user' ||
    (field.schema?.type === 'array' && field.schema?.items === 'user')
  )
}

/**
 * True only for single-user fields. `JiraUserPicker` holds one user, so
 * array-of-user fields stay on the comma-separated text path until the dialog
 * can collect and submit several.
 */
export function isJiraScalarUserCreateField(field: JiraCreateField): boolean {
  return field.schema?.type === 'user'
}

/**
 * Collects the user-typed field keys for the host to shape, which it cannot
 * infer from the values alone since a user id is just a string.
 */
export function getJiraUserCreateFieldKeys(fields: readonly JiraCreateField[]): string[] {
  return fields.filter(isJiraUserCreateField).map((field) => field.key)
}

export function getJiraCreateAllowedValueLabel(
  value: NonNullable<JiraCreateField['allowedValues']>[number]
): string {
  return value.name ?? value.value ?? value.id ?? 'Option'
}

export function findJiraCreateAllowedValue(field: JiraCreateField, draftValue: string) {
  return field.allowedValues?.find((value) => {
    return value.id === draftValue || value.value === draftValue || value.name === draftValue
  })
}

export function getJiraCreateOptionPayload(
  value: NonNullable<JiraCreateField['allowedValues']>[number] | undefined,
  fallback: string
): Record<string, string> | string {
  if (value?.id) {
    return { id: value.id }
  }
  if (value?.value) {
    return { value: value.value }
  }
  if (value?.name) {
    return { name: value.name }
  }
  return fallback
}

export function buildJiraCreateFieldValue(field: JiraCreateField, draftValue: string): unknown {
  const trimmed = draftValue.trim()
  if (!trimmed) {
    return undefined
  }
  if (field.schema?.type === 'array') {
    const parts = trimmed
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
    if (field.allowedValues?.length) {
      return parts.map((part) =>
        getJiraCreateOptionPayload(findJiraCreateAllowedValue(field, part), part)
      )
    }
    return parts
  }
  if (field.allowedValues?.length) {
    return getJiraCreateOptionPayload(findJiraCreateAllowedValue(field, trimmed), trimmed)
  }
  if (field.schema?.type === 'number') {
    const numberValue = Number(trimmed)
    return Number.isFinite(numberValue) ? numberValue : trimmed
  }
  if (field.schema?.custom?.includes(':textarea') || field.schema?.type === 'textarea') {
    return buildJiraCreateTextAdf(trimmed)
  }
  return trimmed
}

export function buildJiraCreateCustomFields(
  fields: readonly JiraCreateField[],
  values: Record<string, string>
): Record<string, unknown> | undefined {
  const customFields: Record<string, unknown> = {}
  for (const field of fields) {
    const value = buildJiraCreateFieldValue(field, values[field.key] ?? '')
    if (value !== undefined) {
      customFields[field.key] = value
    }
  }
  return Object.keys(customFields).length > 0 ? customFields : undefined
}
