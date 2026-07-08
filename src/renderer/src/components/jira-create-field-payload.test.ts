import { describe, expect, it } from 'vitest'
import type { JiraCreateField } from '../../../shared/types'
import { buildJiraCreateCustomFields } from './jira-create-field-payload'

const TEXTAREA_FIELD: JiraCreateField = {
  key: 'customfield_10010',
  name: 'Steps to reproduce',
  required: true,
  schema: {
    type: 'textarea',
    custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea'
  }
}

describe('buildJiraCreateCustomFields', () => {
  it('keeps Jira Server textarea custom fields as plain text', () => {
    expect(
      buildJiraCreateCustomFields(
        [TEXTAREA_FIELD],
        { customfield_10010: 'First line\nSecond line' },
        'server'
      )
    ).toEqual({
      customfield_10010: 'First line\nSecond line'
    })
  })

  it('keeps Jira Cloud textarea custom fields as ADF documents', () => {
    expect(
      buildJiraCreateCustomFields(
        [TEXTAREA_FIELD],
        { customfield_10010: 'First line\nSecond line' },
        'cloud'
      )
    ).toEqual({
      customfield_10010: {
        type: 'doc',
        version: 1,
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'First line' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Second line' }] }
        ]
      }
    })
  })

  it('splits comma-separated array custom fields', () => {
    expect(
      buildJiraCreateCustomFields(
        [
          {
            key: 'customfield_10011',
            name: 'Components',
            required: true,
            schema: { type: 'array', items: 'string' }
          }
        ],
        { customfield_10011: 'alpha, beta, ,gamma' },
        'server'
      )
    ).toEqual({
      customfield_10011: ['alpha', 'beta', 'gamma']
    })
  })

  it('uses allowed-value payloads for option custom fields', () => {
    expect(
      buildJiraCreateCustomFields(
        [
          {
            key: 'customfield_10012',
            name: 'Severity',
            required: true,
            schema: { type: 'option' },
            allowedValues: [{ id: 'option-1', value: 'High' }]
          }
        ],
        { customfield_10012: 'High' },
        'server'
      )
    ).toEqual({
      customfield_10012: { id: 'option-1' }
    })
  })

  it('parses finite number custom fields', () => {
    expect(
      buildJiraCreateCustomFields(
        [
          {
            key: 'customfield_10013',
            name: 'Story points',
            required: true,
            schema: { type: 'number' }
          }
        ],
        { customfield_10013: ' 8 ' },
        'cloud'
      )
    ).toEqual({
      customfield_10013: 8
    })
  })
})
