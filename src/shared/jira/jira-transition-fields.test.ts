import { describe, expect, it } from 'vitest'
import {
  buildResolutionFieldValue,
  transitionAllowedValueKey,
  classifyTransitionRequirements,
  requiredTransitionFields,
  transitionAllowedValueLabel
} from './jira-transition-fields'
import type { JiraTransition } from './jira-types'

const baseTo = {
  id: '3',
  name: 'Done',
  categoryKey: 'done',
  categoryName: 'Done'
}

function transition(fields: JiraTransition['fields']): JiraTransition {
  return { id: '31', name: 'Done', to: baseTo, fields }
}

describe('jira-transition-fields', () => {
  it('treats transitions without required fields as one-click', () => {
    expect(classifyTransitionRequirements(transition(undefined))).toEqual({ kind: 'none' })
    expect(
      classifyTransitionRequirements(
        transition([
          {
            key: 'comment',
            name: 'Comment',
            required: false,
            schema: { type: 'string', system: 'comment' }
          }
        ])
      )
    ).toEqual({ kind: 'none' })
    expect(requiredTransitionFields(transition(undefined))).toEqual([])
  })

  it('classifies resolution (+ optional required comment) as a supported form', () => {
    const resolution = {
      key: 'resolution',
      name: 'Resolution',
      required: true,
      schema: { type: 'resolution', system: 'resolution' },
      allowedValues: [
        { id: '10000', name: 'Done' },
        { id: '10001', name: "Won't Do" }
      ]
    }
    expect(classifyTransitionRequirements(transition([resolution]))).toEqual({
      kind: 'form',
      resolution,
      commentRequired: false
    })
    expect(
      classifyTransitionRequirements(
        transition([
          resolution,
          {
            key: 'comment',
            name: 'Comment',
            required: true,
            schema: { type: 'string', system: 'comment' }
          }
        ])
      )
    ).toEqual({
      kind: 'form',
      resolution,
      commentRequired: true
    })
  })

  it('flags unsupported required field types without attempting a form', () => {
    const custom = {
      key: 'customfield_10050',
      name: 'Close Reason',
      required: true,
      schema: {
        type: 'option',
        custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select'
      },
      allowedValues: [{ id: '1', value: 'Fixed' }]
    }
    expect(
      classifyTransitionRequirements(
        transition([
          custom,
          {
            key: 'resolution',
            name: 'Resolution',
            required: true,
            schema: { type: 'resolution' },
            allowedValues: [{ id: '10000', name: 'Done' }]
          }
        ])
      )
    ).toEqual({ kind: 'unsupported', fields: [custom] })
  })

  it('rejects custom fields with resolution or comment schema hints', () => {
    const customResolution = {
      key: 'customfield_10050',
      name: 'Close reason',
      required: true,
      schema: { type: 'resolution' },
      allowedValues: [{ id: '1', name: 'Fixed' }]
    }
    const customComment = {
      key: 'customfield_10051',
      name: 'Notes',
      required: true,
      schema: { system: 'comment' }
    }
    expect(classifyTransitionRequirements(transition([customResolution, customComment]))).toEqual({
      kind: 'unsupported',
      fields: [customResolution, customComment]
    })
  })

  it('refuses ambiguous duplicate required fields instead of ignoring a requirement', () => {
    const first = {
      key: 'resolution',
      name: 'Resolution',
      required: true,
      allowedValues: [{ id: '1', name: 'Fixed' }]
    }
    const second = { ...first, allowedValues: [{ id: '2', name: 'Duplicate' }] }
    expect(classifyTransitionRequirements(transition([first, second]))).toEqual({
      kind: 'unsupported',
      fields: [first, second]
    })
  })

  it('marks required resolution without choices as unsupported', () => {
    const resolution = { key: 'resolution', name: 'Resolution', required: true }
    expect(classifyTransitionRequirements(transition([resolution]))).toEqual({
      kind: 'unsupported',
      fields: [resolution]
    })
  })

  it('builds resolution payloads from allowed values', () => {
    const field = {
      key: 'resolution',
      name: 'Resolution',
      required: true,
      allowedValues: [
        { id: '10000', name: 'Done' },
        { name: 'Duplicate' },
        { id: '  ', value: 'Fixed' }
      ]
    }
    expect(buildResolutionFieldValue(field, '10000')).toEqual({ id: '10000' })
    expect(buildResolutionFieldValue(field, 'Duplicate')).toEqual({ name: 'Duplicate' })
    expect(buildResolutionFieldValue(field, '  ')).toBeNull()
    expect(buildResolutionFieldValue(field, 'unknown')).toBeNull()
    expect(buildResolutionFieldValue(field, 'Fixed')).toEqual({ value: 'Fixed' })
    expect(transitionAllowedValueLabel({ id: '1', name: 'Done' })).toBe('Done')
    expect(transitionAllowedValueKey({ id: '1', name: 'Done', value: 'done' })).toBe('1')
    expect(transitionAllowedValueKey({ name: 'Duplicate', value: 'dup' })).toBe('dup')
    expect(transitionAllowedValueKey({ name: 'OnlyName' })).toBe('OnlyName')
    expect(transitionAllowedValueKey({ id: '', value: 'dup' })).toBe('dup')
    expect(transitionAllowedValueKey({ id: '  ', name: 'Duplicate' })).toBe('Duplicate')
  })
})
