import type { JiraEditField } from './jira-types'

export type JiraEditFieldEditor =
  | 'text'
  | 'textarea'
  | 'number'
  | 'date'
  | 'datetime'
  | 'select'
  | 'multi-select'
  | 'user'
  | 'strings'
  | 'readonly'

// Reference types Orca can pick from the edit screen's allowedValues.
const OPTION_SCHEMA_TYPES = new Set(['option', 'version', 'component'])
const SCALAR_EDITORS: Readonly<Record<string, JiraEditFieldEditor>> = {
  string: 'text',
  number: 'number',
  date: 'date',
  datetime: 'datetime',
  user: 'user'
}

/**
 * The editor Orca has for a field's schema, or 'readonly' when it has none.
 * Shared so the host only reports fields writable that the sheet can edit.
 */
export function getJiraEditFieldSchemaEditor(
  field: Pick<JiraEditField, 'schema' | 'allowedValues' | 'richText'>
): JiraEditFieldEditor {
  if (field.richText) {
    return 'textarea'
  }
  const { type = '', items = '' } = field.schema ?? {}
  const hasOptions = (field.allowedValues?.length ?? 0) > 0
  if (type === 'array') {
    if (items === 'string' && !hasOptions) {
      return 'strings'
    }
    return OPTION_SCHEMA_TYPES.has(items) && hasOptions ? 'multi-select' : 'readonly'
  }
  if (OPTION_SCHEMA_TYPES.has(type)) {
    return hasOptions ? 'select' : 'readonly'
  }
  return SCALAR_EDITORS[type] ?? 'readonly'
}
