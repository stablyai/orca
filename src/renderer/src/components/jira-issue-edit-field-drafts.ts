import type {
  JiraCreateFieldAllowedValue,
  JiraEditField,
  JiraIssueUpdate
} from '../../../shared/jira/jira-types'
import {
  getJiraEditFieldSchemaEditor,
  type JiraEditFieldEditor
} from '../../../shared/jira/jira-edit-field-editor'
import {
  findJiraCreateAllowedValue,
  getJiraCreateAllowedValueLabel,
  getJiraCreateOptionPayload
} from './task-page-jira-create-fields'

export function getJiraEditFieldEditor(field: JiraEditField): JiraEditFieldEditor {
  return field.writable ? getJiraEditFieldSchemaEditor(field) : 'readonly'
}

/** Stable key for an option; matches Select item values and draft entries. */
export function getJiraEditOptionKey(option: JiraCreateFieldAllowedValue): string {
  return option.id?.trim() || option.value?.trim() || option.name?.trim() || ''
}

export function getJiraEditFieldDisplay(field: JiraEditField): string {
  const { value } = field
  switch (value.kind) {
    case 'empty':
      return ''
    case 'text':
      return value.text
    case 'options':
      return value.options.map(getJiraCreateAllowedValueLabel).join(', ')
    case 'users':
      return value.users.map((user) => user.displayName).join(', ')
    case 'strings':
      return value.values.join(', ')
    case 'unsupported':
      return value.display
  }
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}

/** Jira datetimes (`…+0900`) to a `datetime-local` input value in local time. */
export function jiraDateTimeToLocalInput(value: string): string {
  const date = new Date(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** A `datetime-local` value to the `yyyy-MM-ddTHH:mm:ss.SSS±HHmm` form Jira parses. */
export function jiraDateTimeFromLocalInput(value: string): string | null {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) {
    return null
  }
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.000${sign}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)}`
}

/** The draft an editor starts from: option keys for multi-select, text otherwise. */
export function getJiraEditFieldDraft(field: JiraEditField): string | string[] {
  const { value } = field
  const editor = getJiraEditFieldEditor(field)
  if (editor === 'multi-select') {
    return value.kind === 'options' ? value.options.map(getJiraEditOptionKey).filter(Boolean) : []
  }
  if (editor === 'select') {
    return value.kind === 'options' ? getJiraEditOptionKey(value.options[0] ?? {}) : ''
  }
  if (editor === 'user') {
    return value.kind === 'users' ? (value.users[0]?.accountId ?? '') : ''
  }
  if (editor === 'datetime') {
    return value.kind === 'text' ? jiraDateTimeToLocalInput(value.text) : ''
  }
  return getJiraEditFieldDisplay(field)
}

function optionPayload(field: JiraEditField, key: string): unknown {
  return getJiraCreateOptionPayload(findJiraCreateAllowedValue(field, key), key)
}

function scalarValue(field: JiraEditField, editor: JiraEditFieldEditor, text: string): unknown {
  if (!text) {
    return null
  }
  // undefined marks a draft Jira would reject.
  if (editor === 'number') {
    const number = Number(text)
    return Number.isFinite(number) ? number : undefined
  }
  if (editor === 'datetime') {
    return jiraDateTimeFromLocalInput(text) ?? undefined
  }
  if (editor === 'select') {
    return optionPayload(field, text)
  }
  if (editor === 'strings') {
    return text
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
  }
  return text
}

/**
 * Builds the issue update for a draft, or null when the draft is invalid or
 * would clear a required field.
 */
export function buildJiraEditFieldUpdate(
  field: JiraEditField,
  draft: string | string[]
): JiraIssueUpdate | null {
  const editor = getJiraEditFieldEditor(field)
  if (editor === 'readonly') {
    return null
  }
  const value = Array.isArray(draft)
    ? draft.map((key) => optionPayload(field, key))
    : scalarValue(field, editor, draft.trim())
  const cleared = value === null || (Array.isArray(value) && value.length === 0)
  if (value === undefined || (cleared && field.required)) {
    return null
  }
  const update: JiraIssueUpdate = { fields: { [field.key]: value } }
  if (editor === 'user') {
    update.userFieldKeys = [field.key]
  }
  if (editor === 'textarea') {
    update.richTextFieldKeys = [field.key]
  }
  return update
}
