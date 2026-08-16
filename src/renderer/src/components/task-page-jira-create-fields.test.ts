import { describe, expect, it } from 'vitest'

import {
  buildJiraCreateCustomFields,
  buildJiraCreateFieldValue,
  findJiraCreateAllowedValue,
  getJiraCreateAllowedValueLabel,
  getJiraCreateOptionPayload,
  isJiraCreateMultiUserField,
  isVisibleJiraCreateField,
  jiraCreateFieldNeedsAssignableUsersPicker,
  parseJiraCreateMultiUserDraft,
  toggleJiraCreateMultiUserDraft
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

describe('jiraCreateFieldNeedsAssignableUsersPicker', () => {
  it('requires the fallback picker for a user field without allowed values', () => {
    expect(jiraCreateFieldNeedsAssignableUsersPicker(field({ schema: { type: 'user' } }))).toBe(
      true
    )
  })

  it('uses Jira-provided options when a user field has allowed values', () => {
    expect(
      jiraCreateFieldNeedsAssignableUsersPicker(
        field({ schema: { type: 'user' }, allowedValues: [{ id: 'acc-1' }] })
      )
    ).toBe(false)
  })

  it('does not use the assignable-user picker for non-user fields', () => {
    expect(jiraCreateFieldNeedsAssignableUsersPicker(field({ schema: { type: 'option' } }))).toBe(
      false
    )
  })

  it('requires the picker for a multi-user array field without allowed values', () => {
    expect(
      jiraCreateFieldNeedsAssignableUsersPicker(field({ schema: { type: 'array', items: 'user' } }))
    ).toBe(true)
  })

  it('uses Jira-provided options when a multi-user array field has allowed values', () => {
    expect(
      jiraCreateFieldNeedsAssignableUsersPicker(
        field({ schema: { type: 'array', items: 'user' }, allowedValues: [{ id: 'acc-1' }] })
      )
    ).toBe(false)
  })

  it('does not use the picker for non-user array fields', () => {
    expect(
      jiraCreateFieldNeedsAssignableUsersPicker(
        field({ schema: { type: 'array', items: 'option' } })
      )
    ).toBe(false)
  })
})

describe('isJiraCreateMultiUserField', () => {
  it('detects only arrays of users', () => {
    expect(isJiraCreateMultiUserField(field({ schema: { type: 'array', items: 'user' } }))).toBe(
      true
    )
    expect(isJiraCreateMultiUserField(field({ schema: { type: 'array', items: 'option' } }))).toBe(
      false
    )
    expect(isJiraCreateMultiUserField(field({ schema: { type: 'array' } }))).toBe(false)
    expect(isJiraCreateMultiUserField(field({ schema: { type: 'user' } }))).toBe(false)
    expect(isJiraCreateMultiUserField(field())).toBe(false)
  })
})

describe('parseJiraCreateMultiUserDraft', () => {
  it('splits on commas and drops blanks', () => {
    expect(parseJiraCreateMultiUserDraft(' acc-1, acc-2 ,, ')).toEqual(['acc-1', 'acc-2'])
    expect(parseJiraCreateMultiUserDraft('')).toEqual([])
  })
})

describe('toggleJiraCreateMultiUserDraft', () => {
  it('appends an unselected identifier and removes a selected one', () => {
    expect(toggleJiraCreateMultiUserDraft('', 'acc-1')).toBe('acc-1')
    expect(toggleJiraCreateMultiUserDraft('acc-1', 'acc-2')).toBe('acc-1,acc-2')
    expect(toggleJiraCreateMultiUserDraft('acc-1,acc-2', 'acc-1')).toBe('acc-2')
    expect(toggleJiraCreateMultiUserDraft('acc-1', 'acc-1')).toBe('')
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

  it('serializes Cloud and Server user fields with their expected identifiers', () => {
    const userField = field({ schema: { type: 'user' } })
    expect(buildJiraCreateFieldValue(userField, 'account-1', 'cloud')).toEqual({ id: 'account-1' })
    expect(buildJiraCreateFieldValue(userField, 'username-1', 'server')).toEqual({
      name: 'username-1'
    })
  })

  it('serializes each member of a multi-user field for Cloud and Server', () => {
    const multiUserField = field({ schema: { type: 'array', items: 'user' } })
    expect(buildJiraCreateFieldValue(multiUserField, 'account-1, account-2', 'cloud')).toEqual([
      { id: 'account-1' },
      { id: 'account-2' }
    ])
    expect(buildJiraCreateFieldValue(multiUserField, 'username-1, username-2', 'server')).toEqual([
      { name: 'username-1' },
      { name: 'username-2' }
    ])
  })

  it('keeps Jira-provided options for a multi-user field with allowed values', () => {
    const multiUserField = field({
      schema: { type: 'array', items: 'user' },
      allowedValues: [{ id: 'acc-1', name: 'Name 1' }]
    })
    expect(buildJiraCreateFieldValue(multiUserField, 'Name 1', 'cloud')).toEqual([{ id: 'acc-1' }])
  })

  it('sends the username for a Server user field whose allowed value also has an id', () => {
    const userField = field({
      schema: { type: 'user' },
      allowedValues: [{ id: '10001', name: 'alice' }]
    })
    expect(buildJiraCreateFieldValue(userField, 'alice', 'server')).toEqual({ name: 'alice' })
    expect(buildJiraCreateFieldValue(userField, '10001', 'server')).toEqual({ name: 'alice' })
  })

  it('sends usernames for a Server multi-user field whose allowed values also have ids', () => {
    const multiUserField = field({
      schema: { type: 'array', items: 'user' },
      allowedValues: [
        { id: '10001', name: 'alice' },
        { id: '10002', name: 'bob' }
      ]
    })
    expect(buildJiraCreateFieldValue(multiUserField, '10001, bob', 'server')).toEqual([
      { name: 'alice' },
      { name: 'bob' }
    ])
  })

  it('falls back to the drafted identifier when a Server user is outside the allowed values', () => {
    const userField = field({
      schema: { type: 'user' },
      allowedValues: [{ id: '10001', name: 'alice' }]
    })
    expect(buildJiraCreateFieldValue(userField, 'carol', 'server')).toEqual({ name: 'carol' })
  })

  it('leaves non-user array fields as raw strings', () => {
    const arrayField = field({ schema: { type: 'array', items: 'string' } })
    expect(buildJiraCreateFieldValue(arrayField, 'a, b', 'cloud')).toEqual(['a', 'b'])
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

  it('passes the auth type through to user field serialization', () => {
    const userField = field({ key: 'reporter', schema: { type: 'user' } })
    expect(buildJiraCreateCustomFields([userField], { reporter: 'account-1' }, 'cloud')).toEqual({
      reporter: { id: 'account-1' }
    })
    expect(buildJiraCreateCustomFields([userField], { reporter: 'username-1' }, 'server')).toEqual({
      reporter: { name: 'username-1' }
    })
  })

  it('passes the auth type through to multi-user field serialization', () => {
    const participants = field({
      key: 'customfield_participants',
      schema: { type: 'array', items: 'user' }
    })
    expect(
      buildJiraCreateCustomFields(
        [participants],
        { customfield_participants: 'account-1,account-2' },
        'cloud'
      )
    ).toEqual({ customfield_participants: [{ id: 'account-1' }, { id: 'account-2' }] })
    expect(
      buildJiraCreateCustomFields(
        [participants],
        { customfield_participants: 'username-1,username-2' },
        'server'
      )
    ).toEqual({ customfield_participants: [{ name: 'username-1' }, { name: 'username-2' }] })
  })
})
