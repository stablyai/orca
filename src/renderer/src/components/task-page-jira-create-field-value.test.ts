import { describe, expect, it } from 'vitest'
import {
  buildJiraCreateCustomFields,
  buildJiraCreateFieldValue,
  isVisibleJiraCreateField,
  jiraCreateFieldNeedsAssignableUsersPicker
} from './task-page-jira-create-field-value'
import type { JiraCreateField } from '../../../shared/types'

function field(overrides: Partial<JiraCreateField> = {}): JiraCreateField {
  return { key: 'customfield_1', name: 'Custom', required: true, ...overrides }
}

describe('isVisibleJiraCreateField', () => {
  it('hides the built-in system fields already surfaced by the base form', () => {
    expect(isVisibleJiraCreateField(field({ key: 'project' }))).toBe(false)
    expect(isVisibleJiraCreateField(field({ key: 'summary' }))).toBe(false)
  })

  it('hides optional fields and shows other required fields', () => {
    expect(isVisibleJiraCreateField(field({ required: false }))).toBe(false)
    expect(isVisibleJiraCreateField(field({ required: true }))).toBe(true)
  })
})

describe('jiraCreateFieldNeedsAssignableUsersPicker', () => {
  it('needs the fallback picker for a user field with no allowedValues', () => {
    const reporterField = field({ key: 'reporter', schema: { type: 'user' } })
    expect(jiraCreateFieldNeedsAssignableUsersPicker(reporterField)).toBe(true)
  })

  it('defers to the Jira-provided options for a user field with allowedValues', () => {
    const teamField = field({
      key: 'customfield_team_lead',
      schema: { type: 'user' },
      allowedValues: [{ id: 'acc-1', name: 'Alex Rivera' }]
    })
    expect(jiraCreateFieldNeedsAssignableUsersPicker(teamField)).toBe(false)
  })

  it('does not need the picker for non-user fields', () => {
    expect(jiraCreateFieldNeedsAssignableUsersPicker(field({ schema: { type: 'option' } }))).toBe(
      false
    )
  })
})

describe('buildJiraCreateFieldValue', () => {
  it('wraps a picked Cloud accountId as { id } for user-type fields (#4643)', () => {
    const reporterField = field({ key: 'reporter', schema: { type: 'user' } })
    expect(buildJiraCreateFieldValue(reporterField, '5b10a2844c20165700ede21g', 'cloud')).toEqual({
      id: '5b10a2844c20165700ede21g'
    })
  })

  it('wraps a picked Server username as { name } for user-type fields', () => {
    const reporterField = field({ key: 'reporter', schema: { type: 'user' } })
    expect(buildJiraCreateFieldValue(reporterField, ' wquintal ', 'server')).toEqual({
      name: 'wquintal'
    })
  })

  it('returns undefined for a blank user-field draft rather than an empty id', () => {
    const reporterField = field({ key: 'reporter', schema: { type: 'user' } })
    expect(buildJiraCreateFieldValue(reporterField, '   ')).toBeUndefined()
  })

  it('uses the Jira-provided allowedValue for a user field instead of wrapping the raw draft', () => {
    const teamField = field({
      key: 'customfield_team_lead',
      schema: { type: 'user' },
      allowedValues: [{ id: 'acc-1', name: 'Alex Rivera' }]
    })
    expect(buildJiraCreateFieldValue(teamField, 'acc-1', 'cloud')).toEqual({ id: 'acc-1' })
  })

  it('maps a select field to its allowed-value id', () => {
    const severityField = field({
      schema: { type: 'option' },
      allowedValues: [{ id: 'option-1', value: 'High' }]
    })
    expect(buildJiraCreateFieldValue(severityField, 'option-1')).toEqual({ id: 'option-1' })
  })

  it('splits array fields on commas', () => {
    const labelsField = field({ schema: { type: 'array' } })
    expect(buildJiraCreateFieldValue(labelsField, 'a, b ,c')).toEqual(['a', 'b', 'c'])
  })

  it('coerces number fields', () => {
    const numberField = field({ schema: { type: 'number' } })
    expect(buildJiraCreateFieldValue(numberField, '42')).toBe(42)
  })

  it('falls back to the trimmed string for plain text fields', () => {
    expect(buildJiraCreateFieldValue(field(), '  hello  ')).toBe('hello')
  })
})

describe('buildJiraCreateCustomFields', () => {
  it('sends the reporter as { id } alongside other fields, omitting blanks', () => {
    const fields = [
      field({ key: 'reporter', schema: { type: 'user' } }),
      field({ key: 'customfield_labels', schema: { type: 'array' } }),
      field({ key: 'customfield_empty' })
    ]
    const result = buildJiraCreateCustomFields(
      fields,
      {
        reporter: 'acc-1',
        customfield_labels: 'p1,p2',
        customfield_empty: ''
      },
      'cloud'
    )
    expect(result).toEqual({
      reporter: { id: 'acc-1' },
      customfield_labels: ['p1', 'p2']
    })
  })

  it('sends Server user fields as { name } without changing other field payloads', () => {
    const fields = [
      field({ key: 'reporter', schema: { type: 'user' } }),
      field({ key: 'customfield_labels', schema: { type: 'array' } })
    ]

    expect(
      buildJiraCreateCustomFields(
        fields,
        { reporter: 'wquintal', customfield_labels: 'p1,p2' },
        'server'
      )
    ).toEqual({
      reporter: { name: 'wquintal' },
      customfield_labels: ['p1', 'p2']
    })
  })

  it('returns undefined when every field is blank', () => {
    expect(buildJiraCreateCustomFields([field()], { customfield_1: '' })).toBeUndefined()
  })
})
