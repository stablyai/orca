import { describe, expect, it } from 'vitest'
import type { JiraEditField } from '../../../shared/jira/jira-types'
import {
  buildJiraEditFieldUpdate,
  getJiraEditFieldDisplay,
  getJiraEditFieldDraft,
  getJiraEditFieldEditor,
  jiraDateTimeFromLocalInput,
  jiraDateTimeToLocalInput
} from './jira-issue-edit-field-drafts'

function field(overrides: Partial<JiraEditField>): JiraEditField {
  return {
    key: 'customfield_1',
    name: 'Field',
    required: false,
    operations: ['set'],
    writable: true,
    value: { kind: 'empty' },
    ...overrides
  }
}

const components = field({
  key: 'components',
  name: 'Components',
  schema: { type: 'array', items: 'component' },
  allowedValues: [
    { id: '1', name: 'API' },
    { id: '2', name: 'UI' }
  ],
  value: { kind: 'options', options: [{ id: '2', name: 'UI' }] }
})

describe('getJiraEditFieldEditor', () => {
  it.each([
    [field({ schema: { type: 'string' } }), 'text'],
    [field({ schema: { type: 'string', system: 'description' }, richText: true }), 'textarea'],
    [field({ schema: { type: 'number' } }), 'number'],
    [field({ schema: { type: 'date' } }), 'date'],
    [field({ schema: { type: 'datetime' } }), 'datetime'],
    [field({ schema: { type: 'user' } }), 'user'],
    [field({ schema: { type: 'array', items: 'string' } }), 'strings'],
    [field({ schema: { type: 'option' }, allowedValues: [{ id: '1', value: 'A' }] }), 'select'],
    [components, 'multi-select'],
    // No allowedValues means Orca has nothing to offer, so it only shows the value.
    [field({ schema: { type: 'option' } }), 'readonly'],
    [field({ schema: { type: 'array', items: 'user' } }), 'readonly'],
    [field({ schema: { type: 'string' }, writable: false }), 'readonly']
  ])('picks an editor for %#', (input, editor) => {
    expect(getJiraEditFieldEditor(input)).toBe(editor)
  })
})

describe('buildJiraEditFieldUpdate', () => {
  it('sends option references by id for multi-selects', () => {
    expect(getJiraEditFieldDraft(components)).toEqual(['2'])
    expect(buildJiraEditFieldUpdate(components, ['1', '2'])).toEqual({
      fields: { components: [{ id: '1' }, { id: '2' }] }
    })
  })

  it('clears optional fields and refuses to clear required ones', () => {
    expect(buildJiraEditFieldUpdate(field({ schema: { type: 'string' } }), '  ')).toEqual({
      fields: { customfield_1: null }
    })
    expect(buildJiraEditFieldUpdate({ ...components, required: true }, [])).toBeNull()
  })

  it('rejects numbers Jira cannot parse', () => {
    const points = field({ schema: { type: 'number' } })
    expect(buildJiraEditFieldUpdate(points, '3.5')).toEqual({ fields: { customfield_1: 3.5 } })
    expect(buildJiraEditFieldUpdate(points, 'abc')).toBeNull()
  })

  it('marks user and rich-text keys for the host to shape', () => {
    expect(
      buildJiraEditFieldUpdate(field({ key: 'reporter', schema: { type: 'user' } }), 'acc-1')
    ).toEqual({
      fields: { reporter: 'acc-1' },
      userFieldKeys: ['reporter']
    })
    const description = field({
      key: 'description',
      schema: { type: 'string', system: 'description' },
      richText: true
    })
    expect(buildJiraEditFieldUpdate(description, 'a\nb\n')).toEqual({
      fields: { description: 'a\nb' },
      richTextFieldKeys: ['description']
    })
  })

  it('splits comma-separated string arrays', () => {
    const tags = field({ schema: { type: 'array', items: 'string' } })
    expect(buildJiraEditFieldUpdate(tags, 'a, b,,c ')).toEqual({
      fields: { customfield_1: ['a', 'b', 'c'] }
    })
  })
})

describe('Jira datetimes', () => {
  it('round-trips a datetime-local value through Jira format', () => {
    const jira = jiraDateTimeFromLocalInput('2026-10-16T09:30')
    expect(jira).toMatch(/^2026-10-16T09:30:00\.000[+-]\d{4}$/)
    expect(jiraDateTimeToLocalInput(jira ?? '')).toBe('2026-10-16T09:30')
  })

  it('reads Jira offsets without a colon', () => {
    const expected = new Date('2026-10-16T00:30:00.000Z')
    const pad = (value: number) => String(value).padStart(2, '0')
    expect(jiraDateTimeToLocalInput('2026-10-16T00:30:00.000+0000')).toBe(
      `${expected.getFullYear()}-${pad(expected.getMonth() + 1)}-${pad(expected.getDate())}T${pad(expected.getHours())}:${pad(expected.getMinutes())}`
    )
    expect(jiraDateTimeToLocalInput('not a date')).toBe('')
  })
})

describe('getJiraEditFieldDisplay', () => {
  it('labels every value kind', () => {
    expect(getJiraEditFieldDisplay(components)).toBe('UI')
    expect(
      getJiraEditFieldDisplay(field({ value: { kind: 'unsupported', display: 'Sprint 7' } }))
    ).toBe('Sprint 7')
    expect(getJiraEditFieldDisplay(field({}))).toBe('')
  })
})
