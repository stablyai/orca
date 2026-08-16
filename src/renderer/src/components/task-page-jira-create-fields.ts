import { buildJiraCreateTextAdf } from '@/components/jira-create-adf'
import type { JiraAuthType, JiraCreateField } from '../../../shared/jira-types'

const JIRA_CREATE_SYSTEM_FIELD_KEYS = new Set(['project', 'issuetype', 'summary', 'description'])

export function isVisibleJiraCreateField(field: JiraCreateField): boolean {
  return field.required && !JIRA_CREATE_SYSTEM_FIELD_KEYS.has(field.key)
}

/** Jira multi-user field: an array whose items are users (e.g. Request participants). */
export function isJiraCreateMultiUserField(field: JiraCreateField): boolean {
  return field.schema?.type === 'array' && field.schema.items === 'user'
}

export function jiraCreateFieldNeedsAssignableUsersPicker(field: JiraCreateField): boolean {
  const isUserField = field.schema?.type === 'user' || isJiraCreateMultiUserField(field)
  return isUserField && !field.allowedValues?.length
}

/** Multi-user drafts are stored as a comma-separated list of picked identifiers. */
export function parseJiraCreateMultiUserDraft(draftValue: string): string[] {
  return splitJiraCreateArrayDraft(draftValue)
}

export function toggleJiraCreateMultiUserDraft(draftValue: string, identifier: string): string {
  const selected = parseJiraCreateMultiUserDraft(draftValue)
  const next = selected.includes(identifier)
    ? selected.filter((entry) => entry !== identifier)
    : [...selected, identifier]
  return next.join(',')
}

function splitJiraCreateArrayDraft(draftValue: string): string[] {
  return draftValue
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

function buildJiraCreateUserPayload(identifier: string, authType?: JiraAuthType) {
  return authType === 'server' ? { name: identifier } : { id: identifier }
}

/** Server/DC user pickers take the username, so `name` wins over the option rule's `id`. */
function buildJiraCreateUserFieldPayload(
  field: JiraCreateField,
  identifier: string,
  authType?: JiraAuthType
) {
  const allowedValue = findJiraCreateAllowedValue(field, identifier)
  if (authType === 'server' && allowedValue?.name) {
    return { name: allowedValue.name }
  }
  if (allowedValue) {
    return getJiraCreateOptionPayload(allowedValue, identifier)
  }
  return buildJiraCreateUserPayload(identifier, authType)
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

export function buildJiraCreateFieldValue(
  field: JiraCreateField,
  draftValue: string,
  authType?: JiraAuthType
): unknown {
  const trimmed = draftValue.trim()
  if (!trimmed) {
    return undefined
  }
  if (field.schema?.type === 'array') {
    const parts = splitJiraCreateArrayDraft(trimmed)
    // User arrays resolve ahead of the generic option rule.
    if (isJiraCreateMultiUserField(field)) {
      return parts.map((part) => buildJiraCreateUserFieldPayload(field, part, authType))
    }
    if (field.allowedValues?.length) {
      return parts.map((part) =>
        getJiraCreateOptionPayload(findJiraCreateAllowedValue(field, part), part)
      )
    }
    return parts
  }
  if (field.schema?.type === 'user') {
    return buildJiraCreateUserFieldPayload(field, trimmed, authType)
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
  values: Record<string, string>,
  authType?: JiraAuthType
): Record<string, unknown> | undefined {
  const customFields: Record<string, unknown> = {}
  for (const field of fields) {
    const value = buildJiraCreateFieldValue(field, values[field.key] ?? '', authType)
    if (value !== undefined) {
      customFields[field.key] = value
    }
  }
  return Object.keys(customFields).length > 0 ? customFields : undefined
}
