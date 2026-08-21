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

  it('builds resolution payloads from allowed values', () => {
    const field = {
      key: 'resolution',
      name: 'Resolution',
      required: true,
      allowedValues: [{ id: '10000', name: 'Done' }, { name: 'Duplicate' }]
    }
    expect(buildResolutionFieldValue(field, '10000')).toEqual({ id: '10000' })
    expect(buildResolutionFieldValue(field, 'Duplicate')).toEqual({ name: 'Duplicate' })
    expect(buildResolutionFieldValue(field, '  ')).toBeNull()
    expect(transitionAllowedValueLabel({ id: '1', name: 'Done' })).toBe('Done')
    // Why: draft seed and <option value> must share this id??value??name precedence.
    expect(transitionAllowedValueKey({ id: '1', name: 'Done', value: 'done' })).toBe('1')
    expect(transitionAllowedValueKey({ name: 'Duplicate', value: 'dup' })).toBe('dup')
    expect(transitionAllowedValueKey({ name: 'OnlyName' })).toBe('OnlyName')
  })
})
