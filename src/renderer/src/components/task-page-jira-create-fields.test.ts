import { describe, expect, it } from 'vitest'

import {
  buildJiraCreateCustomFields,
  buildJiraCreateFieldValue,
  findJiraCreateAllowedValue,
  getJiraCreateAllowedValueLabel,
  getJiraCreateOptionPayload,
  getJiraUserCreateFieldKeys,
  isJiraScalarUserCreateField,
  isJiraUserCreateField,
  isVisibleJiraCreateField
} from './task-page-jira-create-fields'
import type { JiraCreateField } from '../../../shared/jira-types'

function field(overrides: Partial<JiraCreateField> = {}): JiraCreateField {
  return { key: 'customfield_1', name: 'Custom', required: true, ...overrides }
}

describe('isVisibleJiraCreateField', () => {
  const cases = [
    { key: 'customfield_1', required: true, expected: true },
    { key: 'customfield_1', required: false, expected: false },
    { key: 'project', required: true, expected: false },
    { key: 'issuetype', required: true, expected: false },
    { key: 'summary', required: true, expected: false },
    { key: 'description', required: true, expected: false },
    // characterization: current behavior — the system-field filter is exact-match
    // and case-sensitive, so a differently-cased key stays visible.
    { key: 'Summary', required: true, expected: true }
  ]

  for (const { key, required, expected } of cases) {
    it(`returns ${expected} for ${key} (required: ${required})`, () => {
      expect(isVisibleJiraCreateField(field({ key, required }))).toBe(expected)
    })
  }
})

describe('isJiraUserCreateField', () => {
  it('matches user pickers, which carry no allowedValues to detect them by', () => {
    expect(isJiraUserCreateField(field({ key: 'reporter', schema: { type: 'user' } }))).toBe(true)
    expect(isJiraUserCreateField(field({ schema: { type: 'array', items: 'user' } }))).toBe(true)
  })

  it('ignores non-user fields', () => {
    expect(isJiraUserCreateField(field({ schema: { type: 'string' } }))).toBe(false)
    expect(isJiraUserCreateField(field({ schema: { type: 'array', items: 'option' } }))).toBe(false)
    expect(isJiraUserCreateField(field())).toBe(false)
  })
})

describe('isJiraScalarUserCreateField', () => {
  it('matches single-user fields the picker can hold', () => {
    expect(isJiraScalarUserCreateField(field({ key: 'reporter', schema: { type: 'user' } }))).toBe(
      true
    )
  })

  it('rejects array-of-user, which the single-value picker would collapse to one member', () => {
    expect(isJiraScalarUserCreateField(field({ schema: { type: 'array', items: 'user' } }))).toBe(
      false
    )
  })

  it('ignores non-user fields', () => {
    expect(isJiraScalarUserCreateField(field({ schema: { type: 'string' } }))).toBe(false)
    expect(isJiraScalarUserCreateField(field())).toBe(false)
  })
})

describe('getJiraUserCreateFieldKeys', () => {
  it('collects only the user-typed keys for the host to shape', () => {
    expect(
      getJiraUserCreateFieldKeys([
        field({ key: 'reporter', schema: { type: 'user' } }),
        field({ key: 'customfield_1', schema: { type: 'string' } }),
        field({ key: 'customfield_2', schema: { type: 'array', items: 'user' } })
      ])
    ).toEqual(['reporter', 'customfield_2'])
  })

  it('returns an empty list when nothing is user-typed', () => {
    expect(getJiraUserCreateFieldKeys([field()])).toEqual([])
  })
})

describe('getJiraCreateAllowedValueLabel', () => {
  it('prefers name, then value, then id', () => {
    expect(getJiraCreateAllowedValueLabel({ id: 'i', value: 'v', name: 'n' })).toBe('n')
    expect(getJiraCreateAllowedValueLabel({ id: 'i', value: 'v' })).toBe('v')
    expect(getJiraCreateAllowedValueLabel({ id: 'i' })).toBe('i')
  })

  it('falls back to Option when nothing is set', () => {
    expect(getJiraCreateAllowedValueLabel({})).toBe('Option')
  })
})

describe('findJiraCreateAllowedValue', () => {
  const withValues = field({
    allowedValues: [
      { id: 'id-1', value: 'val-1', name: 'Name 1' },
      { id: 'id-2', value: 'val-2', name: 'Name 2' }
    ]
  })

  it('matches on id, value, or name', () => {
    expect(findJiraCreateAllowedValue(withValues, 'id-2')?.id).toBe('id-2')
    expect(findJiraCreateAllowedValue(withValues, 'val-1')?.id).toBe('id-1')
    expect(findJiraCreateAllowedValue(withValues, 'Name 2')?.id).toBe('id-2')
  })

  it('returns undefined when there is no match or no allowed values', () => {
    expect(findJiraCreateAllowedValue(withValues, 'nope')).toBeUndefined()
    expect(findJiraCreateAllowedValue(field(), 'id-1')).toBeUndefined()
  })
})

describe('getJiraCreateOptionPayload', () => {
  it('prefers id, then value, then name', () => {
    expect(getJiraCreateOptionPayload({ id: 'i', value: 'v', name: 'n' }, 'fb')).toEqual({
      id: 'i'
    })
    expect(getJiraCreateOptionPayload({ value: 'v', name: 'n' }, 'fb')).toEqual({ value: 'v' })
    expect(getJiraCreateOptionPayload({ name: 'n' }, 'fb')).toEqual({ name: 'n' })
  })

  it('returns the raw fallback string when the option is absent or empty', () => {
    expect(getJiraCreateOptionPayload(undefined, 'fb')).toBe('fb')
    expect(getJiraCreateOptionPayload({}, 'fb')).toBe('fb')
  })

  it('skips empty-string members', () => {
    // characterization: current behavior — the checks are truthiness-based, so an
    // empty id falls through to the next candidate.
    expect(getJiraCreateOptionPayload({ id: '', value: 'v' }, 'fb')).toEqual({ value: 'v' })
  })
})

describe('buildJiraCreateFieldValue', () => {
  it('returns undefined for blank drafts', () => {
    expect(buildJiraCreateFieldValue(field(), '')).toBeUndefined()
    expect(buildJiraCreateFieldValue(field(), '   ')).toBeUndefined()
  })

  it('trims plain string values', () => {
    expect(buildJiraCreateFieldValue(field(), '  hello  ')).toBe('hello')
  })

  it('splits array fields on commas and drops blanks', () => {
    const arrayField = field({ schema: { type: 'array' } })
    expect(buildJiraCreateFieldValue(arrayField, 'a, b ,, c')).toEqual(['a', 'b', 'c'])
  })

  it('maps array parts through allowed values', () => {
    const arrayField = field({
      schema: { type: 'array' },
      allowedValues: [{ id: 'id-1', name: 'Name 1' }]
    })
    expect(buildJiraCreateFieldValue(arrayField, 'Name 1, other')).toEqual([
      { id: 'id-1' },
      'other'
    ])
  })

  it('maps scalar option fields through allowed values', () => {
    const optionField = field({ allowedValues: [{ id: 'id-1', name: 'Name 1' }] })
    expect(buildJiraCreateFieldValue(optionField, 'Name 1')).toEqual({ id: 'id-1' })
    expect(buildJiraCreateFieldValue(optionField, 'Unknown')).toBe('Unknown')
  })

  it('coerces finite numbers and keeps unparseable text', () => {
    const numberField = field({ schema: { type: 'number' } })
    expect(buildJiraCreateFieldValue(numberField, ' 42 ')).toBe(42)
    expect(buildJiraCreateFieldValue(numberField, 'abc')).toBe('abc')
    // characterization: current behavior — Infinity is not finite, so the trimmed
    // text is kept instead of the coerced number.
    expect(buildJiraCreateFieldValue(numberField, 'Infinity')).toBe('Infinity')
  })

  it('builds an ADF document for textarea fields', () => {
    const custom = field({ schema: { custom: 'com.atlassian.jira:textarea' } })
    expect(buildJiraCreateFieldValue(custom, 'line one\nline two')).toEqual({
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'line one' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'line two' }] }
      ]
    })
    expect(buildJiraCreateFieldValue(field({ schema: { type: 'textarea' } }), 'x')).toEqual({
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }]
    })
  })

  it('prefers allowed values over the number branch', () => {
    // characterization: current behavior — the allowedValues branch runs before the
    // number branch, so the draft stays a string even on a number-typed field.
    const numeric = field({ schema: { type: 'number' }, allowedValues: [{ id: 'id-1' }] })
    expect(buildJiraCreateFieldValue(numeric, '7')).toBe('7')
  })
})

describe('buildJiraCreateCustomFields', () => {
  it('returns undefined when every field resolves to undefined', () => {
    expect(buildJiraCreateCustomFields([field({ key: 'a' })], {})).toBeUndefined()
    expect(buildJiraCreateCustomFields([], { a: 'x' })).toBeUndefined()
  })

  it('collects only the fields with values, keyed by field key', () => {
    const fields = [field({ key: 'a' }), field({ key: 'b' }), field({ key: 'c' })]
    expect(buildJiraCreateCustomFields(fields, { a: 'one', b: '  ', c: 'three' })).toEqual({
      a: 'one',
      c: 'three'
    })
  })

  it('treats a missing draft entry as blank', () => {
    expect(buildJiraCreateCustomFields([field({ key: 'a' })], { other: 'x' })).toBeUndefined()
  })
})
